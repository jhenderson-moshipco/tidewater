<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/icons/svg/mark-on-dark.svg">
    <img src="assets/icons/svg/mark-on-light.svg" alt="Tidewater" width="96" height="96">
  </picture>
</p>

# Tidewater

[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

An open-source Postgres client for macOS, Windows and Linux.

Tidewater is a desktop app for working with PostgreSQL: connect to several servers at once, write and run SQL, manage every kind of schema object, and watch server performance live. It is in early development and has no release yet.

## Table of Contents

- [Background](#background)
- [Install](#install)
- [Usage](#usage)
- [Documentation](#documentation)
- [Contributing](#contributing)
- [License](#license)

## Background

Most Postgres clients make you choose between a heavy app, a closed one, or one that connects to a single server at a time. People who work with development and production databases side by side, or with data split across several servers, need more than one connection open at once, and connection setup should take a pasted URL rather than a long form.

Tidewater is built on Tauri, so it uses the operating system's own web view instead of bundling a browser, and a Rust core owns every database connection. The first release aims to cover:

- Several connections open at once, organized into server groups, with clear labels for development, staging and production.
- Simple connection setup: paste a connection URL, find servers running on your machine, or browse AWS RDS, Google Cloud SQL and Supabase instances.
- A query editor that opens and saves `.sql` files, with results fetched in pages instead of all at once.
- Editors for tables, partitions, views, functions, types, roles and the rest of Postgres's native objects.
- A live performance view of sessions, locks, throughput and top statements.
- Themes, a rearrangeable layout, a command palette with editable keybindings, and settings you can export and import without an account.

## Install

There is no release to install yet. To build from source you need:

- Node.js 24 or later and pnpm 11
- Rust (stable)
- The system packages Tauri needs on your platform, listed in the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/)

Then install the JavaScript dependencies:

```bash
git clone https://github.com/jhenderson-moshipco/tidewater.git
cd tidewater
pnpm install
```

## Usage

Run the app in development mode:

```bash
pnpm dev
```

Build an installer for your platform:

```bash
pnpm build
```

Run the Rust core's tests:

```bash
cd apps/desktop/src-tauri && cargo test
```

A few tests connect to a real server. They're skipped unless you point them at one:

```bash
TIDEWATER_TEST_DATABASE_URL="postgres://user:password@localhost:5432/postgres" cargo test -- --ignored
```

The app is early: you can save servers and groups, test a connection step by step, and connect and disconnect. Running queries is next.

## Documentation

- [Frontend guide](docs/frontend.md): where state lives, when effects are allowed, and the component and naming conventions.
- [Brand and icons](docs/brand.md): the mark, how the icon files are generated, and where each one is used.

## Contributing

The project is still being designed, so please open an issue to discuss a change before sending a pull request.

## License

Licensed under the [Apache License 2.0](LICENSE).
