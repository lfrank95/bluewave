Hier legt die CI (Job „client“ in .github/workflows/docker.yml) den gebauten Windows-Client ab, bevor das Image gebaut
wird: `Bluewave-Windows-Client-<version>.exe` und `version.json`. Im Image landet der Ordner unter /opt/bluewave/client;
der Server bietet den Client unter /api/v1/client/download an und der Client holt sich dort seine Updates.
