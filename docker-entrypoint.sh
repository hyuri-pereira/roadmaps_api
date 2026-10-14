#!/bin/sh
set -e
# Cria o banco (se preciso) e aplica schema/migracoes pendentes antes de subir a API.
node dist-scripts/scripts/preparar-banco.js
exec node dist/main.js
