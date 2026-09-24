# Web application

The React + TypeScript client is built as a production bundle and served by Nginx in the `saving-web` container. It calls the API through the same origin at `/api`; do not expose the API container directly.

Run the full application from the repository root with Podman Compose. Product behavior and verified status are documented in the root [README.md](../README.md), [AGENT.md](../AGENT.md), and [PLAN.md](../PLAN.md).
