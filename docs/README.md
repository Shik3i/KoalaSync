# Technical Documentation

This directory contains deep-dives into the KoalaSync protocol, architecture, roadmap, and operational guidelines.

## Start Here by Role

- **Users and reviewers**: Start with [HOW_IT_WORKS.md](HOW_IT_WORKS.md), then [PRIVACY.md](PRIVACY.md) and [TESTED_SERVICES.md](TESTED_SERVICES.md).
- **Self-hosters**: Start with the root [README.md](../README.md), then [devops.md](devops.md), [PROTOCOL.md](PROTOCOL.md), and the examples in `../examples/`.
- **Contributors**: Start with [../CONTRIBUTING.md](../CONTRIBUTING.md), then [ARCHITECTURE.md](ARCHITECTURE.md), [SYNC_GUIDE.md](SYNC_GUIDE.md), and the README for the subdirectory you are editing.
- **AI agents**: Start with [AI_INIT.md](AI_INIT.md), then read the relevant subdirectory README before changing files.
- **Security reviewers**: Start with [SECURITY.md](../SECURITY.md), [KNOWN_LIMITATIONS.md](KNOWN_LIMITATIONS.md), [PRIVACY.md](PRIVACY.md), and [PROTOCOL.md](PROTOCOL.md).

## 🏗️ Core Architecture & Design

- **[ARCHITECTURE.md](ARCHITECTURE.md)**: Overview of the communication flows, Dual Heartbeat architecture, and synchronization logic.
- **[HOW_IT_WORKS.md](HOW_IT_WORKS.md)**: Step-by-step walkthrough of every user flow, from room creation to synchronized playback. Ideal for store reviewers and manual testers.
- **[host-control-mode.md](host-control-mode.md)**: Design, requirements, and edge cases of the Host Control feature.
- **[AI_INIT.md](AI_INIT.md)**: Maintainer and AI-agent onboarding: non-negotiables, workflow order, and safety checks.

## 📡 Protocol & Synchronization

- **[PROTOCOL.md](PROTOCOL.md)**: Low-level message format and payload descriptions for the KoalaSync sync protocol.
- **[SYNC_GUIDE.md](SYNC_GUIDE.md)**: Guide on keeping protocol constants synchronized across the workspace.

## 📋 Compatibility, Roadmap & Contribution

- **[TESTED_SERVICES.md](TESTED_SERVICES.md)**: Status of compatibility with major streaming services and contribution guidelines for testing new platforms.
- **[KNOWN_LIMITATIONS.md](KNOWN_LIMITATIONS.md)**: Threat model and accepted design limitations (NOFIX entries) for security audits.
- **[PRIVACY.md](PRIVACY.md)**: Privacy model and data-handling policy for users, reviewers, and contributors.
- **[ROADMAP.md](ROADMAP.md)**: Planned features, backlog items, and rejected proposals.
- **[TRANSLATION.md](TRANSLATION.md)**: Guide for native speakers to contribute and audit dynamic extension/website translations.

## 🚀 DevOps & Releases

- **[devops.md](devops.md)**: Guide on the automated tag-based release pipeline.
- **[CHANGELOG.md](CHANGELOG.md)**: Detailed history of releases and changes.

---

*For high-level project information and developer setup instructions, refer to the root [README.md](../README.md).*
