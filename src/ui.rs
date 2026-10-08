use std::io::{self, stdout, Stdout};
use crossterm::{
    event::{
        self, DisableMouseCapture, EnableMouseCapture, Event, KeyCode, KeyEventKind,
        KeyModifiers, MouseButton, MouseEventKind,
    },
    execute,
    terminal::{disable_raw_mode, enable_raw_mode, EnterAlternateScreen, LeaveAlternateScreen},
};
use ratatui::{
    backend::CrosstermBackend,
    layout::{Constraint, Direction, Layout, Rect},
    style::{Color, Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Borders, Clear, List, ListItem, ListState, Paragraph},
    Frame, Terminal,
};

use crate::config::{Task, TaskInput};
use crate::runner::Placement;

pub struct TerminalGuard {
    pub terminal: Terminal<CrosstermBackend<Stdout>>,
}

impl TerminalGuard {
    pub fn new() -> io::Result<Self> {
        enable_raw_mode()?;
        let mut stdout = stdout();
        execute!(stdout, EnterAlternateScreen, EnableMouseCapture)?;
        let backend = CrosstermBackend::new(stdout);
        let terminal = Terminal::new(backend)?;
        Ok(Self { terminal })
    }
}

impl Drop for TerminalGuard {
    fn drop(&mut self) {
        let _ = disable_raw_mode();
        let _ = execute!(
            self.terminal.backend_mut(),
            LeaveAlternateScreen,
            DisableMouseCapture
        );
        let _ = self.terminal.show_cursor();
    }
}

pub struct PickerItem<T> {
    pub value: T,
    pub label: String,
    pub detail: Option<String>,
    pub badge: Option<String>,
    pub searchable: String,
}

pub enum PickerResult<T> {
    Selected(T),
    Back,
    Quit,
}

pub fn run_picker<T: Clone>(
    terminal: &mut Terminal<CrosstermBackend<Stdout>>,
    title: &str,
    items: &[PickerItem<T>],
    can_back: bool,
) -> io::Result<PickerResult<T>> {
    let mut query = String::new();
    let mut selected_index = 0;
    let mut list_state = ListState::default();

    loop {
        let filtered: Vec<&PickerItem<T>> = items
            .iter()
            .filter(|item| {
                if query.is_empty() {
                    true
                } else {
                    item.searchable.to_lowercase().contains(&query.to_lowercase())
                }
            })
            .collect();

        if !filtered.is_empty() && selected_index >= filtered.len() {
            selected_index = filtered.len() - 1;
        }

        // Keep the selected item in view: ratatui adjusts the list offset from
        // the state's selection, so this must persist across frames.
        if filtered.is_empty() {
            list_state.select(None);
        } else {
            list_state.select(Some(selected_index));
        }

        let mut list_area = Rect::default();
        terminal.draw(|f| {
            list_area = render_picker(f, title, &query, &filtered, items.len(), selected_index, can_back, &mut list_state);
        })?;

        match event::read()? {
            Event::Key(key) if key.kind != KeyEventKind::Release => {
                match (key.code, key.modifiers) {
                    (KeyCode::Char('c'), KeyModifiers::CONTROL) | (KeyCode::Char('q'), KeyModifiers::NONE) => {
                        return Ok(PickerResult::Quit);
                    }
                    (KeyCode::Esc, _) => {
                        return Ok(if can_back {
                            PickerResult::Back
                        } else {
                            PickerResult::Quit
                        });
                    }
                    (KeyCode::Up, _) | (KeyCode::Char('k'), KeyModifiers::NONE) if query.is_empty() || key.code == KeyCode::Up => {
                        if selected_index > 0 {
                            selected_index -= 1;
                        } else if !filtered.is_empty() {
                            selected_index = filtered.len() - 1;
                        }
                    }
                    (KeyCode::Down, _) | (KeyCode::Char('j'), KeyModifiers::NONE) if query.is_empty() || key.code == KeyCode::Down => {
                        if !filtered.is_empty() {
                            if selected_index + 1 < filtered.len() {
                                selected_index += 1;
                            } else {
                                selected_index = 0;
                            }
                        }
                    }
                    (KeyCode::Enter, _) => {
                        if let Some(chosen) = filtered.get(selected_index) {
                            return Ok(PickerResult::Selected(chosen.value.clone()));
                        }
                    }
                    (KeyCode::Backspace, _) => {
                        query.pop();
                        selected_index = 0;
                    }
                    (KeyCode::Char(c), KeyModifiers::NONE | KeyModifiers::SHIFT) => {
                        query.push(c);
                        selected_index = 0;
                    }
                    _ => {}
                }
            }
            Event::Mouse(mouse) => match mouse.kind {
                MouseEventKind::Down(MouseButton::Left) => {
                    if let Some(idx) = hit_test(
                        list_area,
                        list_state.offset(),
                        mouse.column,
                        mouse.row,
                        filtered.len(),
                    ) {
                        return Ok(PickerResult::Selected(filtered[idx].value.clone()));
                    }
                }
                MouseEventKind::ScrollDown => {
                    if !filtered.is_empty() {
                        if selected_index + 1 < filtered.len() {
                            selected_index += 1;
                        } else {
                            selected_index = 0;
                        }
                    }
                }
                MouseEventKind::ScrollUp => {
                    if !filtered.is_empty() {
                        if selected_index > 0 {
                            selected_index -= 1;
                        } else {
                            selected_index = filtered.len() - 1;
                        }
                    }
                }
                _ => {}
            },
            _ => {}
        }
    }
}

/// Resolve a screen coordinate to the index of a visible list row, accounting
/// for the list's inner area and the first visible (scrolled) item.
fn hit_test(
    list_area: Rect,
    offset: usize,
    column: u16,
    row: u16,
    len: usize,
) -> Option<usize> {
    if list_area.width == 0 || list_area.height == 0 {
        return None;
    }
    let inside = column >= list_area.x
        && column < list_area.x.saturating_add(list_area.width)
        && row >= list_area.y
        && row < list_area.y.saturating_add(list_area.height);
    if !inside {
        return None;
    }
    let idx = offset + (row - list_area.y) as usize;
    if idx < len {
        Some(idx)
    } else {
        None
    }
}

fn render_picker<T>(
    f: &mut Frame,
    title: &str,
    query: &str,
    items: &[&PickerItem<T>],
    total: usize,
    selected_index: usize,
    can_back: bool,
    state: &mut ListState,
) -> Rect {
    let size = f.area();
    let chunks = Layout::default()
        .direction(Direction::Vertical)
        .margin(1)
        .constraints([
            Constraint::Length(3), // Header & Search
            Constraint::Min(3),    // List
            Constraint::Length(1), // Footer Help
        ])
        .split(size);

    // Search bar block
    let filter_text = if query.is_empty() {
        Span::styled("Type to filter...", Style::default().fg(Color::DarkGray))
    } else {
        Span::styled(query, Style::default().fg(Color::Yellow).add_modifier(Modifier::BOLD))
    };

    let search_title = format!(" {title} ({}/{}) ", items.len(), total);
    let search_box = Paragraph::new(Line::from(vec![
        Span::styled("Filter: ", Style::default().fg(Color::Cyan).add_modifier(Modifier::BOLD)),
        filter_text,
    ]))
    .block(
        Block::default()
            .borders(Borders::ALL)
            .title(search_title)
            .border_style(Style::default().fg(Color::Cyan)),
    );
    f.render_widget(search_box, chunks[0]);

    // List of items
    let list_items: Vec<ListItem> = if items.is_empty() {
        vec![ListItem::new(Line::from(vec![
            Span::styled("  No matching tasks found. Press Backspace to clear filter.", Style::default().fg(Color::DarkGray)),
        ]))]
    } else {
        items
            .iter()
            .enumerate()
            .map(|(i, item)| {
                let is_selected = i == selected_index;
                let pointer = if is_selected { "▶ " } else { "  " };

                let mut spans = Vec::new();
                spans.push(Span::styled(
                    pointer,
                    if is_selected {
                        Style::default().fg(Color::Green).add_modifier(Modifier::BOLD)
                    } else {
                        Style::default().fg(Color::DarkGray)
                    },
                ));

                if let Some(ref badge) = item.badge {
                    spans.push(Span::styled(
                        format!("[{badge}] "),
                        Style::default().fg(Color::Magenta).add_modifier(Modifier::BOLD),
                    ));
                }

                spans.push(Span::styled(
                    &item.label,
                    if is_selected {
                        Style::default().fg(Color::White).add_modifier(Modifier::BOLD)
                    } else {
                        Style::default().fg(Color::Gray)
                    },
                ));

                if let Some(ref detail) = item.detail {
                    spans.push(Span::styled(
                        format!("  · {detail}"),
                        Style::default().fg(Color::DarkGray),
                    ));
                }

                ListItem::new(Line::from(spans))
            })
            .collect()
    };

    let list_block = Block::default().borders(Borders::ALL).title(" Commands ");
    let list_inner = list_block.inner(chunks[1]);
    let list_widget = List::new(list_items)
        .block(list_block)
        .highlight_style(
            Style::default()
                .bg(Color::Rgb(30, 40, 60))
                .add_modifier(Modifier::BOLD),
        );
    f.render_stateful_widget(list_widget, chunks[1], state);

    // Footer instructions
    let back_hint = if can_back { " · Esc back" } else { " · Esc/q quit" };
    let footer_text = format!("↑↓/j/k move · Enter/click select · scroll{back_hint}");
    let footer = Paragraph::new(Span::styled(footer_text, Style::default().fg(Color::DarkGray)));
    f.render_widget(footer, chunks[2]);

    list_inner
}

pub fn prompt_string(
    terminal: &mut Terminal<CrosstermBackend<Stdout>>,
    input: &TaskInput,
) -> io::Result<Option<String>> {
    let mut value = input.default.clone().unwrap_or_default();
    let prompt_title = input
        .description
        .as_deref()
        .unwrap_or(&input.id);

    loop {
        terminal.draw(|f| {
            let area = centered_rect(60, 20, f.area());
            f.render_widget(Clear, area);

            let block = Block::default()
                .borders(Borders::ALL)
                .title(format!(" Input: {prompt_title} "))
                .border_style(Style::default().fg(Color::Yellow));

            let text = vec![
                Line::from(vec![
                    Span::styled("Value: ", Style::default().fg(Color::Cyan).add_modifier(Modifier::BOLD)),
                    Span::styled(&value, Style::default().fg(Color::White)),
                    Span::styled("█", Style::default().fg(Color::Green)),
                ]),
                Line::from(""),
                Line::from(Span::styled("Enter submit · Esc cancel", Style::default().fg(Color::DarkGray))),
            ];

            let paragraph = Paragraph::new(text).block(block);
            f.render_widget(paragraph, area);
        })?;

        if let Event::Key(key) = event::read()? {
            match (key.code, key.modifiers) {
                (KeyCode::Esc, _) | (KeyCode::Char('c'), KeyModifiers::CONTROL) => return Ok(None),
                (KeyCode::Enter, _) => return Ok(Some(value)),
                (KeyCode::Backspace, _) => {
                    value.pop();
                }
                (KeyCode::Char(c), KeyModifiers::NONE | KeyModifiers::SHIFT) => {
                    value.push(c);
                }
                _ => {}
            }
        }
    }
}

pub fn task_to_picker_item(task: &Task) -> PickerItem<Task> {
    let badge = task.source.to_string();
    let detail = task.detail.clone().unwrap_or_else(|| task.display_command());
    let searchable = format!("{} {} {}", task.label, badge, detail).to_lowercase();
    PickerItem {
        value: task.clone(),
        label: task.label.clone(),
        detail: Some(detail),
        badge: Some(badge),
        searchable,
    }
}

pub fn placement_picker_items() -> Vec<PickerItem<Placement>> {
    vec![
        PickerItem {
            value: Placement::Tab,
            label: "Run in new tab".to_string(),
            detail: Some("Create a dedicated Herdr tab".to_string()),
            badge: Some("tab".to_string()),
            searchable: "tab run in new tab".to_string(),
        },
        PickerItem {
            value: Placement::Right,
            label: "Run in right pane".to_string(),
            detail: Some("Split workspace to the right".to_string()),
            badge: Some("split".to_string()),
            searchable: "right run in right pane split".to_string(),
        },
        PickerItem {
            value: Placement::Down,
            label: "Run in bottom pane".to_string(),
            detail: Some("Split workspace downwards".to_string()),
            badge: Some("split".to_string()),
            searchable: "down bottom run in bottom pane split".to_string(),
        },
        PickerItem {
            value: Placement::Current,
            label: "Current pane".to_string(),
            detail: Some("Send and run in active pane".to_string()),
            badge: Some("current".to_string()),
            searchable: "current active pane".to_string(),
        },
    ]
}

fn centered_rect(percent_x: u16, percent_y: u16, r: Rect) -> Rect {
    let popup_layout = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Percentage((100 - percent_y) / 2),
            Constraint::Percentage(percent_y),
            Constraint::Percentage((100 - percent_y) / 2),
        ])
        .split(r);

    Layout::default()
        .direction(Direction::Horizontal)
        .constraints([
            Constraint::Percentage((100 - percent_x) / 2),
            Constraint::Percentage(percent_x),
            Constraint::Percentage((100 - percent_x) / 2),
        ])
        .split(popup_layout[1])[1]
}

#[cfg(test)]
mod tests {
    use super::*;
    use ratatui::backend::TestBackend;

    fn picker_items(count: u32) -> Vec<PickerItem<u32>> {
        (0..count)
            .map(|i| PickerItem {
                value: i,
                label: format!("task {i}"),
                detail: None,
                badge: None,
                searchable: format!("task {i}"),
            })
            .collect()
    }

    fn render_at(items: &[PickerItem<u32>], selected: usize) -> String {
        let backend = TestBackend::new(80, 24);
        let mut terminal = Terminal::new(backend).unwrap();
        let refs: Vec<&PickerItem<u32>> = items.iter().collect();
        let mut state = ListState::default();
        if !items.is_empty() {
            state.select(Some(selected));
        }
        terminal
            .draw(|f| {
                render_picker(f, "t", "", &refs, items.len(), selected, false, &mut state);
            })
            .unwrap();
        terminal
            .backend()
            .buffer()
            .content()
            .iter()
            .map(|c| c.symbol())
            .collect()
    }

    #[test]
    fn list_scrolls_to_keep_selection_visible() {
        let items = picker_items(23);
        // An 80x24 popup shows ~16 rows; selecting item 20 must scroll the
        // window so the selection stays on screen.
        let text = render_at(&items, 20);
        assert!(
            text.contains("task 20"),
            "selected item should be visible after scrolling"
        );
        assert!(
            !text.contains("task 0"),
            "list window should have scrolled past the first items"
        );
    }

    #[test]
    fn list_renders_from_top_without_scrolling() {
        let items = picker_items(23);
        let text = render_at(&items, 0);
        assert!(text.contains("task 0"));
    }

    #[test]
    fn empty_filter_shows_message_without_selection() {
        let items = picker_items(0);
        let text = render_at(&items, 0);
        assert!(text.contains("No matching tasks found"));
    }

    #[test]
    fn hit_test_maps_click_to_visible_row() {
        let area = Rect::new(2, 5, 40, 10);
        // First visible row when not scrolled.
        assert_eq!(hit_test(area, 0, 5, 5, 4), Some(0));
        assert_eq!(hit_test(area, 0, 5, 7, 4), Some(2));
        // Scrolling shifts the window: screen row 5 is item 3.
        assert_eq!(hit_test(area, 3, 5, 5, 4), Some(3));
        // A row past the filtered items resolves to nothing.
        assert_eq!(hit_test(area, 3, 5, 6, 4), None);
    }

    #[test]
    fn hit_test_ignores_clicks_outside_list() {
        let area = Rect::new(2, 5, 40, 10);
        // Border column and below the last item.
        assert_eq!(hit_test(area, 0, 1, 5, 4), None);
        assert_eq!(hit_test(area, 0, 5, 4, 4), None);
        assert_eq!(hit_test(area, 0, 5, 15, 4), None);
        assert_eq!(hit_test(Rect::new(0, 0, 0, 0), 0, 0, 0, 4), None);
    }
}
