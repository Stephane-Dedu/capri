# Capri

A desktop companion inspired by Capri, the glitchy construct from *Cyberpunk: Edgerunners* season 2, with Claude Code inside. She's a little cut-paper girl of black shards under a huge glittering hot-pink mane, with a green mask, ringed blue eyes and a black jaw full of jagged white teeth. She lives on top of your screen, **glitch-teleports** around it, and lounges between jobs: perched, legs crossed, lying on her belly in mid-air, hugging a knee, or curled up asleep if you leave her alone.

Click her and you're talking to Claude Code: she reads, edits and runs things in your project, asks before she touches anything, and tells you when she's done. Quick stuff gets a fast answer from Claude Haiku 5.5; real jobs go to Claude Opus 5.5. She also listens to the Claude Code sessions in your terminals, so she can tell you when one of them finishes or needs you, and now and then she has an opinion about what you're doing ("wtf is `utils2_final_REAL.ts`, choom?").

## Run it

You need [Claude Code](https://docs.claude.com/en/docs/claude-code) installed and logged in (run `claude` once and `/login`). Capri uses that login; there's no API key to set up.

```sh
npm install
npm start
```

Then, if you want her to hear from your other Claude Code sessions:

```sh
npm run hooks install     # or tick "Hooked into Claude Code" in her tray menu
```

This adds a few async hooks to `~/.claude/settings.json` (a backup goes to `settings.json.capri-backup`). `npm run hooks uninstall` takes them out again and `npm run hooks status` shows what's there.

## Talking to her

Open the chat (click her, or `Ctrl+Shift+Space`) and ask for anything you'd ask Claude Code. She works in her **project** folder: pick it from the tray menu or with `/cd`.

- **Tool calls** show up as a compact list under her reply, ✓ or ✗ when each one finishes.
- **Permissions**: before an edit or a command she shows a card with the diff or the command. Pick **allow**, **always** (for the rest of the session) or **no**, or just type, which says no and tells her what to do instead. If the chat is closed she pops up a cut-in so you notice.
- **Permission modes**, from the tray or `/mode`: *ask before edits* (default), *accept edits*, *plan only*, *auto*. In plan mode she proposes a plan and asks to go ahead.
- `Esc` stops her mid-task (or closes the chat when she's idle).

### Two brains

Each message goes to one of two models, in the same conversation:

- **Claude Haiku 5.5** at medium effort answers by default: chat, questions, lookups, small edits. It's fast.
- **Claude Opus 5.5** at high effort takes real jobs. A message goes straight to it when it reads like one (refactor, implement, debug, investigate, review, migrate, "think hard", `/init`, `/review`, a long brief, plan mode), and follow-ups to an Opus job stay on Opus for 10 minutes. Haiku can also hand a task up itself when it turns out harder than it looked: it calls a hand-off tool, and Opus continues from the next step with everything so far in context.

The badge in the chat header shows who's answering (HAIKU or a pink OPUS), and the log says when she hands a job up. To pin one model instead, use `/model <name>` or the tray's **Model** menu; `/model auto` switches by task again.

| Command | |
|---|---|
| `/new` | Fresh conversation |
| `/stop` | Stop the current task |
| `/resume` | Pick up her last session in this project |
| `/cd <folder>`, `/pwd` | Change or show her project folder |
| `/mode <mode>` | `default`, `acceptEdits`, `plan` or `auto` |
| `/model auto\|<name>` | Switch by task, or pin a model (`claude-opus-5-5`, `sonnet`…) |
| `/hooks on\|off` | Install or remove the Claude Code hooks |
| `/quiet` | Toggle her commentary on what you do |
| `/commands` | List Claude Code's slash commands in this project |
| `/pose [name]` | Strike a pose for a minute (no name lists them) |
| `/warp`, `/help` | Teleport somewhere / show this list |

Any other `/command` goes to Claude Code, so your custom commands and skills work too.

## Her moods and poses

She picks a pose from what's going on:

| Pose | When |
|---|---|
| **think**: claw at her chin | Waiting on Claude's first words |
| **hack**: floating cross-legged, typing into the air | Claude Code is running tools |
| **point**: arm out at the card | A permission prompt is waiting |
| **victory**: arms up, legs kicking | A long task just finished |
| **crouch**: coiled, claws out | Another session needs your attention |
| **perch**, **crossed**, **chill**, **float**, **lounge**, **hug** | Between jobs, changing every half minute or so |
| **sleep**: curled up, eyes shut | Nothing from you for 4 minutes. Move the mouse near her, save a file or use Claude Code and she's up again |

Each reply starts with a hidden mood tag (`[[smug]]`, `[[hype]]`, `[[glitch]]`…) that sets her face and how she moves: hype bounces, flares her hair and opens her jaw, annoyed makes the hair bristle, soft slows her down, glitch jitters everything.

Her mouth follows the anime: she has no lips, just white teeth cut into a black jaw. Closed, it's a thin zigzag like a lightning bolt; grinning, a band that starts as a thin line and swells into a row of teeth; open, a big wedge hanging under a sawtooth edge; surprised, a small wedge. When she talks the jaw flaps between them.

When she isn't busy she roams: short hops, stutter-step skitters, full-screen warps (mostly toward the edges, out of your way), glitch twitches and idle one-liners. Swipe at her fast and she might dodge. Turn roaming off from the tray, or untick **Visible** to hide her, for example while gaming.

## What she watches, and what it costs

- **Hooks** report `Stop`, `StopFailure`, `Notification`, `UserPromptSubmit` and `PostToolUse` (edits and shell commands) from your Claude Code sessions to `127.0.0.1:47913`. The hook script trims each event to a few fields, gives up after 1.5 s, always exits 0, and costs about 50 ms when she isn't running. The listener only accepts requests with a custom header, so web pages can't post to it.
- **File saves**: she watches her project folder (never your home folder or a drive root), skipping `node_modules`, `.git`, build output and non-code files.
- **Finished tasks and permission prompts** are always announced. Everything else gets a reaction only sometimes (a few events in ten, at most one a minute), written by Claude Haiku 5.5 at low effort with no tools and no settings. Turn them off with `/quiet` or the tray.
- A reaction sends the event to that model: the prompt you typed, the command and its output, or the diff (or top) of the file you saved. Nothing leaves your machine for events that don't get one.
- She ignores her own session, so her own edits don't get comments.

## Controls

| Do this | Get this |
|---|---|
| Click Capri | Open / close the chat |
| Drag Capri | Move her (she doesn't love it) |
| Right-click Capri / tray icon | Menu: project, permissions, model, new conversation, hooks, commentary, wander, warp, quit |
| `Ctrl+Shift+Space` | Summon: she warps next to your cursor with the chat open |
| `Esc` | Stop her, or close the chat |
| `Enter` / `Shift+Enter` | Send / new line |
| `↑` / `↓` in an empty box | Recall earlier messages |
| Click a code block | Copy it |

## Config

Put any of these in `.env` (see `.env.example`):

| Variable | Default | |
|---|---|---|
| `CAPRI_FAST_MODEL` | `claude-haiku-5-5` | Model for quick replies (medium effort) |
| `CAPRI_DEEP_MODEL` | `claude-opus-5-5` | Model for real jobs (high effort) |
| `CAPRI_MODEL` | unset | Pin one model instead of switching |
| `CAPRI_QUIP_MODEL` | `claude-haiku-5-5` | Model for her one-line reactions |
| `CAPRI_CWD` | your home folder | Project folder she starts in |
| `CAPRI_PORT` | `47913` | Port the hooks report to |
| `CAPRI_START_HIDDEN` | unset | `1` starts her hidden in the tray |
| `CAPRI_DEBUG` | unset | `1` opens DevTools and logs Claude Code's stderr |
| `CAPRI_USE_API_KEY` | unset | `1` passes `ANTHROPIC_API_KEY` to Claude Code instead of using your login |

Claude Code prefers an `ANTHROPIC_API_KEY` over your login, so a stale one breaks sign-in with "Invalid API key". Capri drops it unless you set `CAPRI_USE_API_KEY=1`.

The project folder, model, toggles and last session per project are saved in Electron's user data folder (`config.json`).

## How it works

```
src/
  main.js        Electron main: overlay window, tray, hotkey, IPC, wires the agent and companion
  agent.js       Her Claude Code session (Agent SDK): streaming input, model routing and
                 the hand-off tool, tool calls, permission prompts, interrupt, resume, modes
  companion.js   Hook listener, project file watcher, the occasional reaction line
  hooks.js       Installs / removes the hooks in ~/.claude/settings.json
  persona.js     Her voice and mood tags, appended to Claude Code's system prompt
  config.js      Saved settings
  preload.js     The narrow bridge the page is allowed to use
  renderer/
    art.js       Her body as vector layers, generated by tools/trace_art.py (don't edit)
    portrait-art.js  Her face close-up, generated by tools/trace_portrait.py (don't edit)
    mouth.js     Her mouth shapes, shared by the body and the close-up
    poses.js     Her arms and legs, and the pose library
    rig.js       Capri herself: a cut-paper SVG puppet animated "on twos" (12 fps), with
                 per-mood motion, a live face (expressions, blinking, eyes that follow
                 the cursor, a talking jaw) and the glitch tear
    portrait.js  The face close-up for the chat header and the cut-ins, mirroring the rig
    fx.js        Full-screen canvas: shard bursts, data streaks, scanline ghosts, glyphs
    chat.js      The chat panel: streaming text, tool list, permission cards, notices
    app.js       Behavior: poses, wandering, warps, drag/click/dodge, wiring
    quips.js     Canned lines that don't need a model call
tools/
  capri-hook.js  The hook command Claude Code runs
  trace_art.py   Traces her body from a reference frame
  trace_portrait.py  Traces the face close-up
```

- **The brain** is the Claude Agent SDK running Claude Code with its own system prompt plus her voice on top, so she has the full Claude Code toolset and your `CLAUDE.md`, settings and permissions. Her own `AskUserQuestion` is off; permission prompts go through the chat cards instead. Model switches use the SDK's `setModel` and `applyFlagSettings`, and the hand-off is a small in-process MCP tool.
- **The overlay** is one transparent, frameless, always-on-top window over the primary screen's work area. It ignores the mouse, so clicks fall through to whatever's underneath, except over Capri or her chat.
- **The glitch** draws the art once in `<defs>` and renders it through several `<use>` copies: pink and cyan tinted ghosts that split apart, plus horizontal bands that slide sideways. Every copy mirrors the live pose, so the tearing matches what she's doing.
- **Limbs** are chains of tapered, jagged segments (black glass with a violet rim, a green panel on one leg and glittering pink on the other, as in the show) ending in a pointed foot or a claw hand. Poses are joint angles; she eases between them, adds per-pose fidgets (a bobbing foot, typing fingers), trails her legs when she moves, and flickers when she switches.

## Her art

Her head, mane, body and shards are traced, not hand-drawn. `tools/trace_art.py` reads a frame of her from the show (`reference/capri-full.png`, kept out of git) and:

- splits it into flat color layers (pink, dark red, purple rim, blue, green, her violet-black) by color thresholds,
- traces each layer into simplified polygons at 4x resolution, one group per detached shard so shards can jitter on their own,
- lifts the hair glitter out as an alpha mask, plus a sparser twinkle mask that flickers,
- cuts her into puppet pieces: joint polygons carve out the head and torso (the traced legs are cut away, since `poses.js` draws posable ones), and morphological opening splits the mane into a core and the spikes sticking out of it. Each piece gets a pivot, and draws a thin underlay of its neighbors so no seams open while they rotate,
- maps the face, measured on a close-up frame, onto the body through the eye centers. The rig draws the face live so it can blink and talk.

`tools/trace_portrait.py` traces the face close-up (`reference/capri-face-big.png`) the same way, with each eye's ring, iris and highlight measured by hand.

To re-trace, put the frames in `reference/` and run (needs Python 3.11+ with `numpy`, `opencv-python` and `pillow`):

```sh
py tools/trace_art.py
py tools/trace_portrait.py
```

## Ideas for next steps

- Let her see the screen: a screenshot on request, so she can comment on what's in front of you
- Voice: TTS with a bitcrushed filter, push-to-talk input
- Multi-monitor roaming
- More poses: sitting on the edge of the active window, hanging off the top of the screen
