// The dashboard's styles. Colours come from Orca's --orca-* theme variables, which Orca updates in
// place when the theme changes; the four state colours are fixed so they read in both themes.
export const STYLE = `
:root { --cb-blocked: #e5a00d; --cb-waiting: var(--orca-destructive, #e5484d); --cb-working: #3b82f6; --cb-done: #30a46c; --cb-radius: var(--orca-radius, 8px); }
html, body { margin: 0; background: var(--orca-background); color: var(--orca-foreground); font: 13px/1.45 var(--orca-font-sans, system-ui, sans-serif); }
* { box-sizing: border-box; }
.app { padding: 20px 24px 40px; max-width: 1680px; margin: 0 auto; }
.top { display: flex; flex-wrap: wrap; align-items: center; gap: 12px 20px; margin-bottom: 18px; }
.top .title { flex: 1 1 260px; min-width: 0; }
h1 { font-size: 18px; margin: 0 0 2px; font-weight: 600; }
h2 { font-size: 13px; margin: 0; font-weight: 600; text-transform: none; }
h3 { font-size: 13.5px; margin: 0; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.muted { color: var(--orca-muted-foreground); }
.small { font-size: 12px; }
.chips { display: flex; flex-wrap: wrap; gap: 8px; }
.chip { display: inline-flex; align-items: center; gap: 8px; padding: 6px 12px; border: 1px solid var(--orca-border); border-radius: 999px; background: var(--orca-card); }
.chip strong { font-size: 15px; font-variant-numeric: tabular-nums; }
.chip.zero { opacity: .55; }
.dot { width: 8px; height: 8px; border-radius: 50%; flex: none; background: var(--orca-muted-foreground); }
.dot.blocked { background: var(--cb-blocked); } .dot.waiting { background: var(--cb-waiting); }
.dot.working { background: var(--cb-working); } .dot.done { background: var(--cb-done); } .dot.review { background: var(--cb-done); }
.actions { display: flex; gap: 6px; flex-wrap: wrap; }
button { font: inherit; border-radius: 6px; padding: 5px 11px; border: 1px solid var(--orca-border); background: var(--orca-secondary); color: var(--orca-secondary-foreground); cursor: pointer; }
button:hover:not(:disabled) { background: var(--orca-accent); color: var(--orca-accent-foreground); }
button.primary { background: var(--orca-primary); color: var(--orca-primary-foreground); border-color: transparent; }
button.primary:hover:not(:disabled) { opacity: .9; background: var(--orca-primary); color: var(--orca-primary-foreground); }
button.ghost { background: transparent; }
button:disabled { opacity: .5; cursor: default; }
button:focus-visible, textarea:focus-visible, .session:focus-visible, a:focus-visible, input:focus-visible { outline: 2px solid var(--orca-ring); outline-offset: 1px; }
.banner { padding: 10px 12px; border-radius: var(--cb-radius); border: 1px solid var(--cb-waiting); margin-bottom: 14px; }
.layout { display: grid; grid-template-columns: minmax(360px, 5fr) 7fr; gap: 22px; align-items: start; }
@media (max-width: 1050px) { .layout { grid-template-columns: 1fr; } }
.column { display: flex; flex-direction: column; gap: 10px; min-width: 0; }
.column-head { display: flex; align-items: baseline; gap: 8px; padding: 0 2px 2px; }
.count { font-variant-numeric: tabular-nums; color: var(--orca-muted-foreground); }
.card { background: var(--orca-card); color: var(--orca-card-foreground); border: 1px solid var(--orca-border); border-radius: var(--cb-radius); padding: 12px 14px; display: flex; flex-direction: column; gap: 8px; min-width: 0; }
.card.permission { border-left: 3px solid var(--cb-blocked); }
.card.reply { border-left: 3px solid var(--cb-waiting); }
.card.review { border-left: 3px solid var(--cb-done); }
.card-head { display: flex; align-items: center; gap: 8px; min-width: 0; }
.card-head h3 { flex: 1; }
.badge { font-size: 11px; padding: 1px 7px; border-radius: 999px; border: 1px solid var(--orca-border); white-space: nowrap; }
.badge.blocked { color: var(--cb-blocked); border-color: var(--cb-blocked); }
.badge.waiting { color: var(--cb-waiting); border-color: var(--cb-waiting); }
.badge.working { color: var(--cb-working); border-color: var(--cb-working); }
.badge.done, .badge.review { color: var(--cb-done); border-color: var(--cb-done); }
pre.tail { margin: 0; font: 11.5px/1.45 var(--orca-font-mono, ui-monospace, monospace); background: var(--orca-muted); padding: 8px 10px; border-radius: 6px; max-height: 200px; overflow: auto; white-space: pre-wrap; word-break: break-word; }
textarea { width: 100%; min-height: 66px; resize: vertical; background: var(--orca-background); color: inherit; border: 1px solid var(--orca-input, var(--orca-border)); border-radius: 6px; padding: 8px 10px; font: inherit; }
.empty { padding: 28px 16px; text-align: center; border: 1px dashed var(--orca-border); border-radius: var(--cb-radius); }
.lanes { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 12px; }
.bar { display: flex; height: 6px; border-radius: 3px; overflow: hidden; background: var(--orca-muted); }
.bar span { display: block; }
.bar .blocked { background: var(--cb-blocked); } .bar .waiting { background: var(--cb-waiting); }
.bar .working { background: var(--cb-working); } .bar .done { background: var(--cb-done); }
.sessions { display: flex; flex-direction: column; gap: 1px; margin: 0 -6px; }
.session { display: flex; align-items: center; gap: 8px; padding: 5px 6px; border-radius: 6px; cursor: pointer; min-width: 0; }
.closed { display: flex; flex-direction: column; gap: 10px; margin-top: 6px; }
.closed-session { display: flex; flex-direction: column; gap: 6px; }
.closed-session .session { cursor: default; margin: 0 -6px; }
.closed-session .actions { justify-content: flex-end; }
.session:hover { background: var(--orca-accent); color: var(--orca-accent-foreground); }
.session[aria-disabled="true"] { cursor: default; }
.session .name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.session .where { max-width: 40%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
details > summary { cursor: pointer; padding: 2px 0; }
.pulls { display: flex; flex-direction: column; gap: 2px; border-top: 1px solid var(--orca-border); padding-top: 8px; }
.pull { display: flex; gap: 8px; align-items: center; min-width: 0; }
.pull a { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: inherit; }
a { color: var(--orca-primary); }
.picker { max-width: 640px; }
.picker label { display: flex; gap: 10px; align-items: flex-start; padding: 6px 4px; border-radius: 6px; cursor: pointer; }
.picker label:hover { background: var(--orca-accent); }
.history { margin-top: 6px; }
.history li { margin: 4px 0; }
.history ul { padding-left: 18px; margin: 6px 0 0; }
`
