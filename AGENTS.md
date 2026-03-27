# AGENTS.md - AI Coding Agent Guidelines

This repository contains **BMAD Method v6.0** - an AI agent and workflow orchestration framework. This is NOT a traditional code repository with build/test systems; it's a markdown-based framework for defining AI agents and workflows.

## Repository Structure

```
blink-mcp/
├── _bmad/                      # Main BMAD framework
│   ├── _config/                # Manifests and configuration
│   │   ├── agent-manifest.csv  # All agent definitions
│   │   ├── workflow-manifest.csv
│   │   └── manifest.yaml       # Installation metadata
│   ├── core/                   # Core module (bmad-master agent)
│   ├── bmb/                    # BMad Builder (agent/workflow creators)
│   ├── bmm/                    # BMad Method (dev, architect, pm, etc.)
│   ├── cis/                    # Creative & Innovation Suite
│   └── _memory/                # Agent memory storage
├── _bmad-output/               # Workflow output directory
├── .cursor/rules/bmad/         # Cursor IDE rules (.mdc files)
├── .claude/commands/bmad/      # Claude commands
└── .opencode/                  # OpenCode agent/command files
```

## Build/Lint/Test Commands

**This framework has NO build, lint, or test commands.** It consists entirely of:
- Markdown files (`.md`) for agents and documentation
- YAML files (`.yaml`) for configuration and workflows
- XML files (`.xml`) for task definitions
- CSV files (`.csv`) for manifests and data

No compilation, transpilation, or testing infrastructure exists.

## Workflow Execution

Workflows are executed via the core task runner:
```
{project-root}/_bmad/core/tasks/workflow.xml
```

To invoke a workflow, reference its `workflow.yaml` and execute using the workflow.xml task runner.

## Code Style Guidelines

### File Formats

| Type | Format | Location |
|------|--------|----------|
| Agents | Markdown with embedded XML | `_bmad/{module}/agents/*.md` |
| Workflows | YAML config + markdown steps | `_bmad/{module}/workflows/*` |
| Tasks | XML | `_bmad/{module}/tasks/*.xml` |
| IDE Rules | MDC (Cursor) | `.cursor/rules/bmad/*.mdc` |
| Config | YAML | `_bmad/{module}/config.yaml` |

### Agent File Structure

```markdown
---
name: "agent-name"
description: "Agent description"
---

You must fully embody this agent's persona...

```xml
<agent id="..." name="..." title="..." icon="...">
  <activation critical="MANDATORY">
    <step n="1">...</step>
    <step n="2">Load config from {project-root}/_bmad/{module}/config.yaml</step>
  </activation>
  <persona>
    <role>...</role>
    <identity>...</identity>
    <communication_style>...</communication_style>
    <principles>...</principles>
  </persona>
  <menu>
    <item cmd="...">[CMD] Menu Item Description</item>
  </menu>
</agent>
```
```

### Workflow Structure

```
workflow-folder/
├── workflow.yaml           # Main configuration (REQUIRED)
├── instructions.xml        # Step instructions
├── steps/                  # Sequential step files (optional)
│   ├── step-01-init.md
│   ├── step-02-process.md
│   └── step-03-complete.md
├── templates/              # Output templates
└── checklist.md            # Validation checklist
```

### Naming Conventions

- **Step files**: `step-XX-name.md` (XX = zero-padded number)
- **Continuation handlers**: `step-XXb-continue.md`
- **Agents**: lowercase with hyphens (`dev.md`, `quick-flow-solo-dev.md`)
- **Workflows**: lowercase with hyphens (`dev-story`, `create-prd`)
- **Variables**: `{variable_name}` with underscores, wrapped in curly braces

### Variable Resolution

System variables:
- `{project-root}` - Repository root path
- `{installed_path}` - Current workflow installation path
- `{output_folder}` - Output directory from config
- `{user_name}` - User's name from config
- `{communication_language}` - Language for output
- `{date}` - System-generated date

Config references: `{config_source}:field_name`

### Critical Rules (from workflow.xml)

1. **Always read COMPLETE files** - NEVER use offset/limit on workflow files
2. **Instructions are MANDATORY** - Execute ALL steps IN EXACT ORDER
3. **Save after EVERY template-output tag** - Never batch saves
4. **NEVER skip a step** - Agent is responsible for every step
5. **Steps execute in numerical order** (1, 2, 3...)
6. **Optional steps**: Ask user unless #yolo mode is active

### Execution Modes

- **normal**: Full user interaction and confirmation at EVERY step
- **yolo**: Skip confirmations, auto-complete with simulated expert user

### Menu Pattern

Agent menus use this format:
```
[A] Advanced Elicitation [C] Continue [P] Party Mode [Y] YOLO
```

Handlers respond to:
- Number input → Execute menu item[n]
- Text input → Case-insensitive substring match
- Multiple matches → Ask user to clarify

## Module Overview

| Module | Purpose | Key Agents |
|--------|---------|------------|
| **core** | Platform foundation | bmad-master |
| **bmb** | Builder tools | agent-builder, workflow-builder, module-builder |
| **bmm** | Development method | analyst, architect, dev, pm, sm, tea, ux-designer |
| **cis** | Creative/Innovation | brainstorming-coach, design-thinking-coach, storyteller |

## IDE Integration

### Cursor Rules
Located in `.cursor/rules/bmad/`. Reference with:
- `@bmad/{module}/agents/{agent-name}`
- `@bmad/{module}/workflows/{workflow-name}`
- `@bmad/index` for master index

### OpenCode Agents
Located in `.opencode/agent/`. Files follow pattern: `bmad-agent-{module}-{agent-name}.md`

### Claude Commands
Located in `.claude/commands/bmad/`. Organized by module.

## Error Handling

- If config not loaded: STOP and report error to user
- If workflow path is "todo": Inform user workflow not yet implemented
- If no matches for file patterns: Set variable to empty string, note to user

## Key Principles

1. **Micro-file architecture**: Each step is self-contained, <200 lines
2. **JIT loading**: Load files only when needed, never pre-load
3. **Append-only documents**: Content grows by appending
4. **Story file is single source of truth**: Tasks/subtasks sequence is authoritative
5. **Red-green-refactor**: Write failing test first, then implementation
6. **Project-context.md**: If exists at `**/project-context.md`, treat as authoritative bible

## Common Operations

### Activate an Agent
1. Load agent file from `_bmad/{module}/agents/{agent}.md`
2. Execute ALL activation steps in order
3. Load module config: `_bmad/{module}/config.yaml`
4. Display greeting and menu
5. Wait for user input

### Execute a Workflow
1. Load `workflow.xml` from `_bmad/core/tasks/workflow.xml`
2. Load target `workflow.yaml`
3. Resolve all variables from config_source
4. Execute instructions step by step
5. Save output after each template-output tag
6. Confirm with user before proceeding (unless #yolo)
