# Campaign orchestration — running multi-screen builds with agents

Lessons from a rebuild campaign (35+ screens, multiple agents, one canvas). All generic.

## Dispatch discipline

- **1 AGENT = 1 KIND OF WORK.** Never bundle fixes/kit-work/sweeps into a screen-build task — an agent burns 150–300k tokens; the preamble work eats the budget and the build starves (real cost: 2h, 0 screens). Builds, fixes, sweeps, gate-work are SEPARATE dispatches, interleaved when the canvas hand is free.
- **Batch by budget:** >6 dense screens → split into waves (e.g. base+5 states / rest+overlay), one agent each. The next wave continues from a DONE-list — nothing is lost by splitting.
- Spec per agent: context paths + concrete node ids + acceptance criteria + an explicit "do ONLY X; Y/Z are later tasks".
- **Mid-run directives drop silently** (even when "queued" reports success). Prefer waiting for idle + a separate task; if you must interrupt, require an explicit ACK in the final report — no ACK = treat as dropped, verify by artifact evidence, send a corrective task.
- Sequencing orders are phrased as **closing conditions** ("not done until X"), not mid-run messages.
- One canvas hand: mutations sequential; read-only recon (REST/metadata by fileKey) may run in parallel with a mutation agent.

## STUDY-FIRST (no exceptions)

- Read the relevant conventions/docs + the reference master screens BEFORE building. Measure references by node reads, never eyeball from screenshots.
- **Inventory from the derived cache / registry, never from a page listing** (listings go stale). Grep the inventory before concluding "missing".
- Write a short `{task}-learnings.md` BEFORE the build: conventions learned → how they'll be applied / deviations + reasons. The post-build report's diff table ("spec → applied / DEVIATED + reason") must cover every learning + every create-new.
- **Measurement beats supplied numbers.** Numbers in a brief are study-table data, not law — if the source clips content, the source is wrong (screen height follows CONTENT, clip 0). Recompute every foreign measurement from the formula that produced it.

## Safety rails per mutation batch

- `saveVersionHistoryAsync('pre-{task}')` (or the bridge's checkpoint) BEFORE the first mutation of a task.
- **Backup-edit protocol** for editing an existing shared master: clone to `_backup/{name}/{yymmdd}` → edit in place → verify (node reads + fresh PNG + mini usage-sweep of instances) → delete backup. Legit exception: a 1-node, 1-command-reversible op on a HUGE set (>100 variants) may rely on the version checkpoint instead — declare it in the report; never widen this exception to structural edits.
- File guard + status double-check per build-script-standard.md.

## Canvas organization (owner law: "organize is important as hell")

- Every screen = a named SECTION (`{App} · {Screen}`), ordered per backlog; state frames laid out left→right inside, fixed gap, top-aligned.
- Page-content/masters never mixed into screen sections — a dedicated `_Masters …` section; fixtures/demos → `_Fixtures`.
- A finished build is PLACED in its section immediately — **a floating frame on canvas = failed gate.**

## Closing a wave

- **Tool change-logs may NOT capture script mutations** (UI-edit ledgers miss exec-js work) — after any hand-build wave, run the FULL derived-cache re-scan chain, with EXPLICIT `--out` flags (defaults write to CWD and silently leave the canonical cache stale); verify by the registry count moving by exactly the expected delta.
- Run the gate suite over the wave's scope + attach gates.json to the report (quality-gate-system.md).
- Visual-regression baselines re-accepted after master edits, on the same machine/fonts.
- Toolchain check at wave start: run the toolchain's doctor/update and scan new commands — integrate anything that fits the process into the skill immediately.
- Remind the owner: library mutations are pending changes — publish when the batch is coherent.
