# ---------------------------------------------------------------------------
# Loan Eligibility Engine - developer shortcuts
#
#   make up        start postgres, n8n and mailpit
#   make crawl     run the discovery crawl through n8n and print the JSON
#   make demo      the whole pipeline: crawl, ingest, match, notify
#   make test      the unit tests and the end to end test
# ---------------------------------------------------------------------------
SHELL := /bin/bash
PYTHON ?= python3

.DEFAULT_GOAL := help
.PHONY: help up down logs migrate build import crawl match notify demo test test-unit test-e2e test-slow test-js lint clean

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
		| awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-12s\033[0m %s\n", $$1, $$2}'

up: ## Start the whole stack (postgres, n8n, mailpit, api, worker)
	docker compose up -d --build
	@echo "upload  -> http://127.0.0.1:8000"
	@echo "n8n     -> http://127.0.0.1:5678"
	@echo "mailpit -> http://127.0.0.1:8025"

down: ## Stop the local stack
	docker compose down

logs: ## Follow the n8n logs
	docker compose logs -f n8n

migrate: ## Apply the database migrations
	$(PYTHON) scripts/migrate.py

build: ## Rebuild the n8n workflow files from the templates and modules
	$(PYTHON) scripts/build_workflows.py --profile test

import: ## Push the workflows and the credentials into n8n
	$(PYTHON) scripts/import_workflows.py --activate --smtp-host mailpit --smtp-port 1025

crawl: ## Run the discovery crawl through n8n and print the extracted JSON
	$(PYTHON) scripts/crawl.py

match: ## Match the newest batch and notify the applicants
	$(PYTHON) scripts/match.py --latest

notify: ## Notify the applicants of the newest batch
	$(PYTHON) scripts/notify.py --latest

demo: ## The whole pipeline: crawl, upload a file, match and notify
	$(PYTHON) scripts/crawl.py --quiet > /dev/null
	$(PYTHON) scripts/upload.py samples/users_small.csv
	$(PYTHON) scripts/match.py --latest

upload: ## Upload an applicant file through the HTTP interface
	$(PYTHON) scripts/upload.py $(or $(FILE),samples/users.csv)

test: ## Run the python tests (including the end to end test) and the node tests
	$(PYTHON) -m pytest tests -v
	node --test tests/js

test-unit: ## Run only the tests that do not need the stack
	$(PYTHON) -m pytest tests -m "not e2e and not slow" -v
	node --test tests/js

test-e2e: ## Run the end to end test (scheduler -> crawl -> ingest -> match -> notify)
	$(PYTHON) -m pytest tests -m e2e -v

test-slow: ## Wait for the cron of Workflow A to fire on its own
	$(PYTHON) -m pytest tests -m slow -v

test-js: ## Run the tests of the Code node modules
	node --test tests/js

lint: ## Check that the python sources compile
	$(PYTHON) -m compileall -q app scripts tests

clean: ## Remove caches and generated artefacts
	find . -type d -name __pycache__ -prune -exec rm -rf {} +
	rm -rf .pytest_cache
