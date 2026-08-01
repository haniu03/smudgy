# tintin-emulator

Interprets [TinTin++](https://tintin.mudhalla.net/) commands typed at the input
line. Definitions become normal smudgy automations, visible in the automations
window, and persist between sessions. `#read` loads existing `.tin` files from
the package's data folder. The command character defaults to `#` and is a
package option.

```
#action {%1 tells you %2} {tell %1 heard you!}
#alias {gt} {guildtell %0}
#highlight {Zombie Lord} {bold red}
#if {$hp < 100} {cast 'cure critic'}
```

## Supported commands

| Command | Notes |
| --- | --- |
| `#action`, `#unaction` | Triggers on lines from the game. Captures in `%1`-`%99`, priority 1-9. |
| `#alias`, `#unalias` | Shortcuts for what you type. `%0` is everything after the name, `%1`-`%9` the words. |
| `#all` | Sends one command to every connected session. |
| `#bell` | Prints a bell marker. There is no audible bell. |
| `#break`, `#continue`, `#return` | Loop and function control. |
| `#cat` | Appends text to a variable. |
| `#class` | open, close, assign, kill, size. Tags definitions for bulk removal. |
| `#cr` | Sends a blank line. |
| `#delay`, `#undelay` | Runs commands once, N seconds from now. |
| `#echo` | Formatted output. `%s`, `%d`, `%p` and `%t` work. |
| `#event`, `#unevent` | Session connected/disconnected, lines sent and received, typed input. |
| `#foreach` | Loops over a list. |
| `#format` | printf into a variable; `%t` takes a strftime format. |
| `#function`, `#unfunction` | Called as `@name{args}`; `#return` sets the value. |
| `#gag`, `#ungag` | Hides matching lines. |
| `#help`, `#commands` | This table, in the client. |
| `#highlight`, `#unhighlight` | Recolors every occurrence on the line. |
| `#if`, `#elseif`, `#else` | TinTin's expression language, dice rolls included. |
| `#ignore` | Pauses a whole kind at once (actions, aliases, tickers...). |
| `#info` | Counts of everything defined. |
| `#list` | create, add, delete, insert, sort, find, size and more. 1-based, like TinTin. |
| `#local`, `#unlocal` | Variables that live only inside the running block. |
| `#loop` | Counted loop, either direction. |
| `#macro`, `#unmacro` | F1-F12, arrows, Home/End, PageUp/PageDown, Insert/Delete. |
| `#math` | Evaluates an expression into a variable. |
| `#nop` | A comment. |
| `#parse` | Loops over the characters of a string. |
| `#path` | Full recorded-route cursor: create/load, get/goto/move, map, run/walk, swap, undo, save, zip/unzip. |
| `#pathdir`, `#unpathdir` | The direction table, each entry with its reverse for backtracking. |
| `#prompt`, `#unprompt` | Rewrites the prompt; given a row and an open split, parks it there. |
| `#read` | Loads a `.tin` file from the package's data folder. |
| `#regexp` | One-shot match with `&1`-`&99` captures and an else branch. |
| `#replace` | Pattern replacement inside a variable. |
| `#send` | Sends text to the game. |
| `#session` | Lists connected sessions. `#<name> {command}` sends to one of them. |
| `#showme` | Local echo, `<118>`-style colors and all. |
| `#split`, `#unsplit` | A status pane above the terminal. |
| `#substitute`, `#unsubstitute` | Rewrites matching lines as they arrive. |
| `#switch`, `#case`, `#default` | No fall-through, same as TinTin. |
| `#ticker`, `#unticker` | Repeats every N seconds. |
| `#variable`, `#unvariable` | Persistent variables; nested tables via `[brackets]`. |
| `#while` | Loops while a condition holds. |
| `#write` | Saves your definitions and variables out as a `.tin` file. |

Abbreviations resolve the TinTin way (`#ali`, `#sh`, `#var`), semicolons split
commands outside braces, `\;` stays literal, and braces nest across lines.

Enable **TinTin speedwalks** in the package's options to expand lowercase v1
speedwalks typed at the input line, such as `2s5w3s3w2nw`. It defaults to off.
As in TinTin++, input-line speedwalks use one-letter `n/e/s/w/u/d` directions,
so `2ne` means `n;n;e`. Use `#path unzip` for v2 speedwalks with diagonal or
custom `#pathdir` names. User aliases get the first chance to match the whole
input; expanded direction steps then go directly to the MUD.

## Errata

- Every matching action fires, in priority order. TinTin fires only the
  highest-priority match.
- Definitions persist on their own. `#write` exports; it is not needed to keep
  your work.
- Patterns run on smudgy's matching engine, which has no lookaround or
  backreferences, for performance reasons.
- `#split` opens a pane above the terminal. A row number routes text to the
  pane; lines append there rather than at specific rows
- `#send` goes through alias processing.
- `#map`, `#buffer`, `#grep`, `#history`, `#draw`, `#button`, `#system`, `#run`, `#script`, `#chat`, `#port`, `#ssl` and `#daemon` are unavailable
