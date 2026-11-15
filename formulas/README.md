# Formulas imported at startup

Every `*.yaml` or `*.yml` file in this directory is imported when the
container starts. A formula whose name matches an existing workflow updates
it. This is how workflows are kept as code next to your deployment.

Copy `../examples/clickup-to-pr.formula.yaml` here to start from the example.
Files must be readable by everyone (`chmod 644`), because the server runs
without the capability to bypass file permissions.
