.PHONY: docker-up seed-db

docker-up:
	docker compose up -d

seed-db:
	docker compose exec app php artisan db:seed --force
