// Orca's shadcn recipes on the --orca-* tokens a frame receives. Each fallback is Orca's built-in theme
// value, so the dev harness and a default-themed desktop frame look the same. Status hues are not
// exposed to frames, so they are Orca's own values per mode.
export const STYLE = String.raw`
:root{
--bg:var(--orca-background,#fff);--fg:var(--orca-foreground,#0a0a0a);--card:var(--orca-card,#fff);
--primary:var(--orca-primary,#171717);--primary-fg:var(--orca-primary-foreground,#fafafa);
--secondary:var(--orca-secondary,#f5f5f5);--secondary-fg:var(--orca-secondary-foreground,#171717);
--muted:var(--orca-muted,#f5f5f5);--muted-fg:var(--orca-muted-foreground,#696969);
--accent:var(--orca-accent,#f5f5f5);--accent-fg:var(--orca-accent-foreground,#171717);
--destructive:var(--orca-destructive,#e40014);
--border:var(--orca-border,#e5e5e5);--input:var(--orca-input,#e5e5e5);--ring:var(--orca-ring,#a1a1a1);
--radius:var(--orca-radius,.625rem);
--font-sans:var(--orca-font-sans,'Geist',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif);
--font-mono:var(--orca-font-mono,'SF Mono',SFMono-Regular,ui-monospace,'Cascadia Code',Menlo,Consolas,'Liberation Mono',monospace);
--success:#147638;--warning:#ca8a04;--warning-text:color-mix(in oklab,var(--warning) 70%,var(--fg));
--link:#0969da;--question:#f54900;--working:#efb100;--idle:color-mix(in oklab,#737373 40%,transparent);
--r-sm:calc(var(--radius)*.6);--r-md:calc(var(--radius)*.8);--r-lg:var(--radius);--r-xl:calc(var(--radius)*1.4);
--shadow-xs:0 1px 2px 0 rgb(0 0 0/.05);--shadow-sm:0 1px 3px 0 rgb(0 0 0/.1),0 1px 2px -1px rgb(0 0 0/.1);
--focus:0 0 0 3px color-mix(in oklab,var(--ring) 50%,transparent);
color-scheme:light}
html.dark{
--bg:var(--orca-background,#0a0a0a);--fg:var(--orca-foreground,#f0f0f0);--card:var(--orca-card,#171717);
--primary:var(--orca-primary,#e5e5e5);--primary-fg:var(--orca-primary-foreground,#171717);
--secondary:var(--orca-secondary,#262626);--secondary-fg:var(--orca-secondary-foreground,#f0f0f0);
--muted:var(--orca-muted,#262626);--muted-fg:var(--orca-muted-foreground,#acacac);
--accent:var(--orca-accent,#404040);--accent-fg:var(--orca-accent-foreground,#f0f0f0);
--destructive:var(--orca-destructive,#ff6568);
--border:var(--orca-border,rgb(255 255 255/.07));--input:var(--orca-input,rgb(255 255 255/.15));--ring:var(--orca-ring,#737373);
--success:#86efac;--warning:#eab308;--warning-text:var(--warning);--link:#4493f8;--question:#fe6e00;
color-scheme:dark}
html.light{color-scheme:light}
*,*::before,*::after{box-sizing:border-box}
html,body{margin:0;height:100%;background:var(--bg)}
body{color:var(--fg);font:400 14px/20px var(--font-sans);letter-spacing:.01em;-webkit-font-smoothing:antialiased}
#board-root{height:100%}
button,input,textarea{font:inherit;letter-spacing:inherit}
p{margin:0}
.scroll{overflow:auto;min-height:0}
.scroll::-webkit-scrollbar{width:12px;height:12px}
.scroll::-webkit-scrollbar-track,.scroll::-webkit-scrollbar-corner{background:transparent}
.scroll::-webkit-scrollbar-thumb{background-color:color-mix(in oklab,var(--muted-fg) 28%,transparent);border:3px solid transparent;background-clip:padding-box;border-radius:9999px;min-height:28px}
.scroll::-webkit-scrollbar-thumb:hover{background-color:color-mix(in oklab,var(--muted-fg) 48%,transparent)}
.scroll::-webkit-scrollbar-thumb:active{background-color:color-mix(in oklab,var(--fg) 36%,transparent)}
.muted{color:var(--muted-fg)}
.sm{font-size:12px;line-height:16px}
.danger{color:var(--destructive)}
.warn{color:var(--warning-text)}
.ok{color:var(--success)}
.ellipsis{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.clamp2{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.surface{background:var(--card);border:1px solid color-mix(in oklab,var(--border) 50%,transparent);box-shadow:var(--shadow-sm)}
html.dark .surface{border-color:var(--border)}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;height:36px;max-width:100%;padding:0 16px;border-radius:var(--r-md);border:1px solid transparent;background:transparent;color:var(--fg);font-size:14px;font-weight:500;line-height:20px;white-space:nowrap;cursor:pointer;outline:none;transition:color .15s,background-color .15s,opacity .15s}
.btn:focus-visible{border-color:var(--ring);box-shadow:var(--focus)}
.btn:disabled{opacity:.5;pointer-events:none}
.btn svg{width:16px;height:16px;flex:none}
.btn-sm{height:32px;padding:0 12px;gap:6px}
.btn-xs{height:24px;padding:0 8px;gap:4px;font-size:12px}
.btn-primary{background:var(--primary);color:var(--primary-fg)}
.btn-primary:hover{background:color-mix(in oklab,var(--primary) 90%,transparent)}
.btn-secondary{background:var(--secondary);color:var(--secondary-fg)}
.btn-secondary:hover{background:color-mix(in oklab,var(--secondary) 80%,transparent)}
.btn-outline{border-color:var(--border);background:var(--bg);box-shadow:var(--shadow-xs)}
.btn-outline:hover{border-color:color-mix(in oklab,var(--muted-fg) 35%,transparent);background:var(--accent);color:var(--accent-fg)}
html.dark .btn-outline{border-color:var(--input);background:color-mix(in oklab,var(--input) 30%,transparent)}
html.dark .btn-outline:hover{background:color-mix(in oklab,var(--input) 50%,transparent)}
.btn-ghost{color:var(--muted-fg)}
.btn-ghost:hover{background:var(--accent);color:var(--accent-fg)}
html.dark .btn-ghost:hover{background:color-mix(in oklab,var(--accent) 50%,transparent)}
.btn.selected,html.dark .btn.selected{border-color:color-mix(in oklab,var(--muted-fg) 35%,transparent);background:var(--accent);color:var(--accent-fg)}
.link-muted{display:inline-flex;align-items:center;padding:6px 3px;border:0;background:none;color:var(--muted-fg);font-size:13px;line-height:16px;text-decoration:underline;text-underline-offset:4px;cursor:pointer;border-radius:var(--r-sm)}
.link-muted:hover{color:var(--fg)}
.link-muted:focus-visible{outline:none;box-shadow:var(--focus)}
.textarea{display:block;width:100%;min-height:56px;padding:8px 12px;border:1px solid var(--input);border-radius:var(--r-md);background:transparent;color:var(--fg);font-size:14px;line-height:20px;box-shadow:var(--shadow-xs);resize:vertical;outline:none;transition:border-color .15s,box-shadow .15s}
html.dark .textarea{background:color-mix(in oklab,var(--input) 30%,transparent)}
.textarea::placeholder{color:var(--muted-fg)}
.textarea:focus{border-color:var(--ring);box-shadow:var(--focus)}
.textarea:disabled{opacity:.5;cursor:not-allowed}
.textarea-strong{min-height:64px;padding:10px;border-width:2px;border-color:color-mix(in oklab,var(--muted-fg) 55%,transparent)}
.textarea-strong:focus{border-color:var(--primary)}
.select{height:32px;min-width:0;max-width:100%;padding:0 8px;border:1px solid var(--input);border-radius:var(--r-md);background:transparent;color:var(--fg);font-size:14px;box-shadow:var(--shadow-xs);outline:none;cursor:pointer;text-overflow:ellipsis}
html.dark .select{background:color-mix(in oklab,var(--input) 30%,transparent)}
.select:focus-visible{border-color:var(--ring);box-shadow:var(--focus)}
.select:disabled{opacity:.5;cursor:not-allowed}
.select option{background:var(--card);color:var(--fg)}
.send-wrap{position:relative;display:inline-flex;max-width:100%}
.tooltip{position:absolute;bottom:100%;left:0;z-index:90;margin-bottom:6px;padding:6px 12px;border-radius:var(--r-md);background:var(--fg);color:var(--bg);font-size:12px;line-height:16px;white-space:nowrap;pointer-events:none}
.tooltip[hidden]{display:none}
.thread{display:flex;flex-direction:column;gap:7px;width:100%;padding:8px 12px;border-radius:var(--r-md);background:var(--muted)}
.link{color:var(--link);text-decoration:underline;text-underline-offset:2px;cursor:pointer;background:none;border:0;padding:0;font:inherit}
.chip{display:inline-flex;align-items:center;align-self:flex-start;gap:2px;flex:none;height:28px;max-width:100%;padding:0 8px 0 12px;border-radius:9999px;border:1px solid var(--border);background:var(--bg);color:var(--fg);font-size:12px;font-weight:500;line-height:16px;white-space:nowrap;cursor:pointer;box-shadow:var(--shadow-xs);outline:none}
.chip:hover{background:var(--accent);color:var(--accent-fg)}
.chip:focus-visible{border-color:var(--ring);box-shadow:var(--focus)}
.chip svg{width:12px;height:12px;flex:none;color:var(--muted-fg)}
html.dark .chip{border-color:var(--input);background:color-mix(in oklab,var(--input) 30%,transparent)}
html.dark .chip:hover{background:color-mix(in oklab,var(--input) 50%,transparent)}
.tabs{display:inline-flex;align-items:center;align-self:flex-start;height:28px;padding:3px;border-radius:var(--r-lg);background:var(--muted);color:var(--muted-fg)}
.tab{display:inline-flex;align-items:center;justify-content:center;height:100%;padding:0 10px;border-radius:var(--r-md);border:1px solid transparent;background:transparent;color:color-mix(in oklab,var(--fg) 60%,transparent);font-size:12px;font-weight:500;line-height:16px;white-space:nowrap;cursor:pointer;outline:none}
.tab:hover{color:var(--fg)}
html.dark .tab{color:var(--muted-fg)}
html.dark .tab:hover{color:var(--fg)}
.tab[aria-checked=true],html.dark .tab[aria-checked=true]{background:var(--bg);color:var(--fg);box-shadow:var(--shadow-sm)}
html.dark .tab[aria-checked=true]{border-color:var(--input);background:color-mix(in oklab,var(--input) 30%,transparent)}
.tab:focus-visible{box-shadow:var(--focus)}
.tab:disabled{opacity:.5;pointer-events:none}
.badge{display:inline-flex;align-items:center;gap:6px;align-self:flex-start;max-width:100%;padding:2px 8px;border-radius:9999px;border:1px solid transparent;font-size:12px;font-weight:500;line-height:16px;white-space:nowrap}
.badge-secondary{background:var(--secondary);color:var(--secondary-fg)}
.badge-outline{border-color:var(--border);color:var(--fg)}
.badge-warning{border-color:color-mix(in oklab,var(--warning) 25%,transparent);background:color-mix(in oklab,var(--warning) 10%,transparent);color:var(--warning-text)}
.badge-danger{background:var(--destructive);color:#fff}
html.dark .badge-danger{background:color-mix(in oklab,var(--destructive) 60%,transparent)}
.state{display:inline-flex;align-items:center;justify-content:center;width:10px;height:10px;flex:none}
.state svg{width:10px;height:10px}
.state-dot{display:block;width:6px;height:6px;border-radius:9999px}
.spin{animation:spin 1s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion:reduce){.spin{animation:none}}
.project-icon{display:inline-flex;align-items:center;justify-content:center;width:17px;height:17px;flex:none;border-radius:5px;color:var(--fg);font-size:11px;font-weight:700;line-height:1;letter-spacing:0;object-fit:contain}
.section-label{font-size:11px;font-weight:600;line-height:16px;color:var(--muted-fg)}
.list-row{display:flex;gap:8px;width:100%;padding:8px;border:0;border-radius:var(--r-md);background:transparent;color:var(--fg);text-align:left;cursor:pointer;outline:none}
.list-row:hover{background:color-mix(in oklab,var(--accent) 60%,transparent)}
.list-row[aria-selected=true]{background:var(--accent)}
.list-row:focus-visible{box-shadow:inset 0 0 0 2px color-mix(in oklab,var(--ring) 60%,transparent)}
.press{display:flex;width:100%;border:0;background:transparent;color:inherit;text-align:left;padding:0;cursor:pointer;border-radius:var(--r-sm);outline:none}
.press:focus-visible{box-shadow:var(--focus)}
.disclosure-head{display:flex;align-items:center;justify-content:space-between;gap:8px;width:100%;min-height:44px;padding:8px 12px;border:0;border-radius:var(--r-xl);background:transparent;color:var(--fg);font-weight:600;text-align:left;cursor:pointer;outline:none}
.disclosure-head:hover{background:color-mix(in oklab,var(--accent) 50%,transparent)}
.disclosure-head:focus-visible{box-shadow:var(--focus)}
.disclosure-head svg{width:16px;height:16px;color:var(--muted-fg);flex:none}
.md{display:flex;flex-direction:column;gap:6px;min-width:0}
.md-p{font-size:14px;line-height:21px;overflow-wrap:anywhere;white-space:pre-wrap}
.md-muted .md-p{font-size:13px;color:var(--muted-fg)}
.md-title{font-size:15px;font-weight:600}
.md-h1{font-size:16px;font-weight:700}
.md-h3{font-size:14px;font-weight:700}
.md-code{font-family:var(--font-mono);font-size:12px;line-height:18px;background:var(--muted);padding:6px;border-radius:var(--r-sm)}
.md code{font-family:var(--font-mono);font-size:.9em;background:var(--muted);border-radius:4px;padding:0 3px}
.md-quote{display:flex;flex-direction:column;gap:4px;border-left:2px solid var(--border);padding-left:8px}
.md-list{display:flex;flex-direction:column;gap:4px}
.md-item{display:flex;gap:6px}
.md-table{display:flex;flex-direction:column}
.md-tr{display:flex;border-bottom:1px solid var(--border)}
.md-td{flex:1;min-width:0;padding:4px}
.md hr{width:100%;height:1px;border:0;background:var(--border);margin:0}
.ribbon-card{display:flex;flex-direction:column;gap:4px;flex:none;width:210px;padding:12px;border:1px solid var(--border);border-radius:var(--r-lg);background:var(--bg);color:var(--fg);text-align:left;cursor:pointer;outline:none}
.ribbon-card:hover{background:color-mix(in oklab,var(--accent) 50%,transparent)}
.ribbon-card:active{background:var(--card)}
.ribbon-card[aria-expanded=true]{border-color:var(--muted-fg)}
.ribbon-card:focus-visible{box-shadow:var(--focus)}
.cell-button{display:flex;flex-direction:column;gap:4px;min-width:0;padding:12px;border:0;background:transparent;color:var(--fg);text-align:left;cursor:pointer;outline:none}
.cell-button:hover:not(:disabled){background:color-mix(in oklab,var(--accent) 50%,transparent)}
.cell-button:active:not(:disabled){background:var(--card)}
.cell-button[aria-expanded=true]{background:var(--accent)}
.cell-button:disabled{cursor:default}
.cell-button:focus-visible{box-shadow:inset 0 0 0 2px color-mix(in oklab,var(--ring) 60%,transparent)}
.table-head{background:color-mix(in oklab,var(--muted) 50%,transparent)}
`;
