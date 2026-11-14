.PHONY: tf-plan k8s-restart

tf-plan:
	terraform -chdir=ops/infra plan -out=tfplan

k8s-restart:
	kubectl -n platform rollout restart deployment/$(DEPLOYMENT)
