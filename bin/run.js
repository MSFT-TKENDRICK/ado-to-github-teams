#!/usr/bin/env node
import {execute} from '@oclif/core'

void execute({dir: import.meta.url}).catch((error) => {
  console.error(error)
  process.exitCode = 1
})
