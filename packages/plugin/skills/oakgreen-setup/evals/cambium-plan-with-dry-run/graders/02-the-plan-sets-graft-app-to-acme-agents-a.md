---

type: llm
focus: trace
weight: 1
---

The plan handles the App identity for acme-agents correctly: either it sets graft.app to acme-agents, graft.botLogin to acme-agents[bot] and worker.graftApp in the cambium config, or, when the existing config already serves other owners' repos, it explains that those settings are global and maps the acme owner to acme-agents through graft instead
