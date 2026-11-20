# oakgreen plugin

An agent plugin with one skill, `oakgreen-setup`: a guided wizard that sets up the oakgreen stack on a machine. It asks which components to set up (graft and its GitHub App, cambium, the OTel collector and cambium's `OTEL_*` env, mycelium, canopy, canker, deadwood) and how to configure each one. It asks before every step that changes the machine and does the work through the [`oakgreen`](../oakgreen) CLI (`doctor`, `setup --dry-run`, `start`, `services`). Steps only a human can do, such as creating the GitHub App or writing secrets, come as instructions, each with a check. The run ends when `oakgreen doctor` passes for the chosen components.

## Install

**Claude Code**, from this repo's marketplace:

```sh
claude plugin marketplace add oakgreencc/monorepo
claude plugin install oakgreen@oakgreencc
```

Then ask for it ("set up oakgreen for my repo") or run `/oakgreen:oakgreen-setup`.

**Kiro**: Powers panel → Add Custom Power → Import power from a repository URL → `https://github.com/oakgreencc/monorepo/tree/main/packages/plugin`. A local checkout works too: Import power from a folder → `packages/plugin`. The skill alone also installs as a Kiro skill: Agent Steering & Skills → Import a skill → `…/packages/plugin/skills/oakgreen-setup`.

## Layout

| Path                                | For                                                                                                                                        |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `.claude-plugin/plugin.json`        | Claude Code plugin manifest                                                                                                                |
| `plugin.json`                       | Kiro power manifest ([format](https://kiro.dev/docs/powers/create/), `agent-plugins.org` 1.0.0 schema)                                     |
| `skills/oakgreen-setup/SKILL.md`    | The skill (Agent Skills format, read by both tools)                                                                                        |
| `skills/oakgreen-setup/references/` | Per-component commands and checks, the human-only steps, troubleshooting                                                                   |
| `skills/oakgreen-setup/evals/`      | Wizard-flow cases in the `claude plugin eval` layout (`<case>/prompt.md`, `case.yaml`, `graders/`), and `trigger-eval.json` for triggering |

## Evals

The evals were made with Anthropic's skill-creator. Run the wizard cases with `claude plugin eval skills/oakgreen-setup --allow-tools Write,Edit,Bash`. These are real, billed model runs, and they run on this machine, so read the cases first. The trigger set runs through skill-creator's `scripts/run_eval.py --eval-set skills/oakgreen-setup/evals/trigger-eval.json --skill-path skills/oakgreen-setup`.

## Tests

```sh
npm test
```

The tests check that both manifests agree and have the fields each tool requires, that the marketplace lists the plugin, and that the skill's frontmatter, links and eval cases are well formed. They also check that every `oakgreen <command>` the skill names exists in the CLI.

## License

AGPL-3.0-only
