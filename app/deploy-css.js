// Deployment styling for the standalone /deploy page (body.deploy-page) and
// the in-cockpit deployment modal (#deployBackdrop). Every rule is scoped to
// one of those roots: this stylesheet is also injected into deploy-configured
// cockpit pages, where a bare .button/.badge/.version/a/... would restyle
// unrelated cockpit UI.
export const deployCss = `
body.deploy-page{font-family:system-ui,-apple-system,Segoe UI,sans-serif;margin:0;padding:1.5rem 2rem;background:#0f172a;color:#e5e7eb}
.deploy-page h1{margin:0 0 .2rem}
:is(.deploy-page,#deployBackdrop) .top{display:flex;justify-content:space-between;align-items:center;margin-bottom:1.5rem}
:is(.deploy-page,#deployBackdrop) .subtitle{color:#94a3b8;margin:0}
:is(.deploy-page,#deployBackdrop) .button{display:inline-block;padding:.5rem 1rem;background:#2563eb;color:#fff;border:none;border-radius:8px;cursor:pointer;text-decoration:none;font-size:.9rem}
:is(.deploy-page,#deployBackdrop) .button:hover{filter:brightness(1.1)}
:is(.deploy-page,#deployBackdrop) .button.secondary{background:#374151;color:#e5e7eb}:is(.deploy-page,#deployBackdrop) .button.secondary:hover{background:#4b5563}
:is(.deploy-page,#deployBackdrop) .button.danger{background:#991b1b}:is(.deploy-page,#deployBackdrop) .button.danger:hover{background:#b91c1c}
:is(.deploy-page,#deployBackdrop) .button.small{padding:.3rem .7rem;font-size:.8rem}
:is(.deploy-page,#deployBackdrop) .button:disabled{opacity:.5;cursor:not-allowed}
:is(.deploy-page,#deployBackdrop) .project-card{background:#111827;border:1px solid #374151;border-radius:12px;padding:1.2rem 1.5rem;margin-bottom:1.2rem}
:is(.deploy-page,#deployBackdrop) .project-card h2{margin:0 0 .8rem;font-size:1.2rem;color:#f8fafc}
:is(.deploy-page,#deployBackdrop) .targets{display:grid;grid-template-columns:1fr 1fr;gap:1rem}
:is(.deploy-page,#deployBackdrop) .target-card{border:1px solid #334155;border-radius:8px;padding:1rem;background:#0b1220}
:is(.deploy-page,#deployBackdrop) .target-card h3{margin:0 0 .5rem;font-size:.95rem;text-transform:uppercase;letter-spacing:.05em}
:is(.deploy-page,#deployBackdrop) .target-card.dev h3{color:#6ee7b7}
:is(.deploy-page,#deployBackdrop) .target-card.prod h3{color:#fca5a5}
:is(.deploy-page,#deployBackdrop) .version{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.85rem;background:#020617;border:1px solid #334155;padding:.2rem .5rem;border-radius:4px;display:inline-block;margin:.3rem 0;color:#bbf7d0}
:is(.deploy-page,#deployBackdrop) .version-line{display:flex;align-items:center;gap:.4rem;flex-wrap:wrap}
:is(.deploy-page,#deployBackdrop) .probe-btn{padding:.15rem .45rem;line-height:1;font-size:.85rem}
:is(.deploy-page,#deployBackdrop) .top-actions{display:flex;gap:.6rem;align-items:center}
:is(.deploy-page,#deployBackdrop) #probe-all.probing{opacity:.7;cursor:progress}
:is(.deploy-page,#deployBackdrop) .last-deploy{font-size:.8rem;color:#94a3b8;margin:.4rem 0}
:is(.deploy-page,#deployBackdrop) .config-section{margin-top:.8rem;border-top:1px solid #1f2937;padding-top:.8rem}
:is(.deploy-page,#deployBackdrop) .config-section label{display:block;font-size:.8rem;font-weight:600;color:#cbd5e1;margin-bottom:.3rem}
:is(.deploy-page,#deployBackdrop) .config-section textarea,:is(.deploy-page,#deployBackdrop) .config-section input{width:100%;box-sizing:border-box;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.8rem;padding:.4rem .5rem;border:1px solid #334155;border-radius:4px;resize:vertical;background:#020617;color:#e5e7eb}
:is(.deploy-page,#deployBackdrop) .config-section textarea{min-height:60px}
:is(.deploy-page,#deployBackdrop) .deploy-output{margin-top:.5rem;background:#020617;border:1px solid #1f2937;color:#e2e8f0;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.75rem;padding:.6rem;border-radius:4px;max-height:200px;overflow:auto;white-space:pre-wrap;display:none}
:is(.deploy-page,#deployBackdrop) .deploy-output.show{display:block}
:is(.deploy-page,#deployBackdrop) .log-table{width:100%;border-collapse:collapse;font-size:.8rem;margin-top:.5rem}
:is(.deploy-page,#deployBackdrop) .log-table th{text-align:left;border-bottom:2px solid #1f2937;padding:.4rem .5rem;color:#94a3b8;font-size:.78rem;text-transform:uppercase;letter-spacing:.02em}
:is(.deploy-page,#deployBackdrop) .log-table td{border-bottom:1px solid #1f2937;padding:.4rem .5rem}
:is(.deploy-page,#deployBackdrop) .log-table .ok{color:#6ee7b7}:is(.deploy-page,#deployBackdrop) .log-table .fail{color:#fca5a5}
:is(.deploy-page,#deployBackdrop) .badge{display:inline-block;padding:.15rem .5rem;border-radius:99px;font-size:.75rem;font-weight:600}
:is(.deploy-page,#deployBackdrop) .badge.ok{background:rgba(16,185,129,.12);border:1px solid #065f46;color:#6ee7b7}:is(.deploy-page,#deployBackdrop) .badge.fail{background:rgba(239,68,68,.12);border:1px solid #991b1b;color:#fca5a5}
:is(.deploy-page,#deployBackdrop) .no-config{color:#94a3b8;font-style:italic;font-size:.85rem}
:is(.deploy-page,#deployBackdrop) .muted{color:#94a3b8;font-size:.85rem}
:is(.deploy-page,#deployBackdrop) .local-version{font-size:.9rem;margin-bottom:.8rem;color:#cbd5e1}
:is(.deploy-page,#deployBackdrop) .local-version .version.source{background:#1e3a8a;border-color:#3b82f6;color:#93c5fd}
:is(.deploy-page,#deployBackdrop) a{color:#93c5fd}
:is(.deploy-page,#deployBackdrop) .deploy-tabs{display:flex;gap:0;border-bottom:2px solid #1f2937;margin-bottom:1rem}
:is(.deploy-page,#deployBackdrop) .deploy-tab{background:transparent;border:none;color:#94a3b8;padding:.5rem 1.2rem;font:inherit;font-size:.9rem;cursor:pointer;border-bottom:2px solid transparent;margin-bottom:-2px;transition:color .15s,border-color .15s}
:is(.deploy-page,#deployBackdrop) .deploy-tab:hover{color:#e5e7eb}
:is(.deploy-page,#deployBackdrop) .deploy-tab.active{color:#93c5fd;border-bottom-color:#3b82f6;font-weight:600}
@media(max-width:760px){:is(.deploy-page,#deployBackdrop) .targets{grid-template-columns:1fr}:is(.deploy-page,#deployBackdrop) .top{align-items:flex-start;flex-direction:column}}
`;
