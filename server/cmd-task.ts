// A task's wrapper on Windows without Git Bash (see tasks.ts). A detached cmd.exe
// has no console, so each program it starts would get a console of its own, and its
// output would not reach the log. This wrapper, detached itself, starts cmd.exe with
// a hidden console and writes the exit code. Its arguments: the task's mark
// ("codiner-task <id> session <sid>"), then the file for the exit code.

import { spawn } from 'node:child_process'
import fs from 'node:fs'

const exitFile = process.argv[3]
spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${process.env.CODINER_TASK_COMMAND}"`], { stdio: 'inherit', windowsHide: true, windowsVerbatimArguments: true })
  .on('exit', (code) => fs.writeFileSync(exitFile, `${code ?? ''}\n`))
