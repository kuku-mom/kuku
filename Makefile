ROOT_DIR := $(patsubst %/,%,$(dir $(abspath $(lastword $(MAKEFILE_LIST)))))
TARGET ?= .
TARGET_DIR := $(abspath $(ROOT_DIR)/$(TARGET))

export GOLANGCI_LINT_CACHE := $(ROOT_DIR)/.cache/golangci-lint
export GOCACHE := $(ROOT_DIR)/.cache/go-build

GO ?= go
GOLANGCI_LINT := $(GO) tool -modfile=$(ROOT_DIR)/golangci-lint.mod golangci-lint
GOLANGCI_CONFIG := $(ROOT_DIR)/.golangci.yaml

.PHONY: prepare format format-check lint lint-fix fix test build server-build sqlc-generate db-migrate dev

prepare:
	mkdir -p "$(GOLANGCI_LINT_CACHE)" "$(GOCACHE)"

format: prepare
	cd "$(TARGET_DIR)" && $(GOLANGCI_LINT) fmt --config "$(GOLANGCI_CONFIG)"

format-check: prepare
	cd "$(TARGET_DIR)" && $(GOLANGCI_LINT) fmt --config "$(GOLANGCI_CONFIG)" --diff

lint: prepare
	cd "$(TARGET_DIR)" && $(GOLANGCI_LINT) run --config "$(GOLANGCI_CONFIG)"

lint-fix: prepare
	cd "$(TARGET_DIR)" && $(GOLANGCI_LINT) run --config "$(GOLANGCI_CONFIG)" --fix

fix: prepare
	cd "$(TARGET_DIR)" && $(GOLANGCI_LINT) fmt --config "$(GOLANGCI_CONFIG)"
	cd "$(TARGET_DIR)" && $(GOLANGCI_LINT) run --config "$(GOLANGCI_CONFIG)" --fix

test: prepare
	cd "$(TARGET_DIR)" && $(GO) test ./...

build: prepare
	cd "$(TARGET_DIR)" && $(GO) build ./...

server-build: prepare
	cd "$(TARGET_DIR)" && $(GO) build -o ./bin/server ./cmd/server

sqlc-generate: prepare
	cd "$(TARGET_DIR)" && $(GO) tool sqlc generate

db-migrate: prepare
	cd "$(TARGET_DIR)" && $(GO) run ./cmd/server migrate

dev: prepare
	cd "$(TARGET_DIR)" && ENV_PATH=.env.dev $(GO) tool air -c .air.toml
