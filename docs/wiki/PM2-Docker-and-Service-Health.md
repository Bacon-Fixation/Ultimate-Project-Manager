# PM2, Docker, and Service Health

## PM2

UPM can match projects to PM2 processes and show status, CPU, memory, GPU when available, HTTP metrics, uptime, restarts, logs, and interactive history charts.

Process controls are explicit. Confirm the matched process before start/restart/stop actions, especially when multiple projects use similar PM2 names.

## Docker startup gate

Projects that depend on Docker or Docker Desktop can delay PM2 startup until Docker is ready. This avoids repeated crashes caused by starting an application before its containers/services are available.

## Service health

Project health checks can monitor supported local services such as:

- Redis
- MariaDB / MySQL
- PostgreSQL
- Docker
- HTTP / HTTPS endpoints
- TCP endpoints

Use these checks as operational signals, not as a substitute for application-specific health logic.

## History charts

Host and PM2 history charts support hover/focus inspection of exact samples. Keyboard users can focus a chart and move through samples with the arrow keys, Home, and End.
