#!/usr/bin/env bun
// Entrypoint kept separate from cli.ts: Bun auto-serves an entry module whose
// default export has .fetch (incur CLIs do), which would hang every invocation.
import cli from './cli'

cli.serve()
