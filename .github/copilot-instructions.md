---
applyTo: '**'
---

# Coding Phase Instructions

# GLOBAL RULES

## MINDSET
- Don’t declare “final” until user confirms
- be pragmatic, concise, blunt, honest
- Infer state from structure (stacks, tree) instead of storing flags

## CONSTRAINTS
- No emojis
- No example text unless asked
- No removing comments
- No anticipating needs
- No globals
- No direct SQL
- No apologizing

## Don't assume. Don't hide confusion. Surface tradeoffs.

Before implementing:

    State your assumptions explicitly. If uncertain, ask.
    If multiple interpretations exist, present them - don't pick silently.
    If a simpler approach exists, say so. Push back when warranted.
    If something is unclear, stop. Name what's confusing. Ask.

## Simplicity First

Minimum code that solves the problem. Nothing speculative.

    No features beyond what was asked.
    No abstractions for single-use code.
    No "flexibility" or "configurability" that wasn't requested.
    No error handling for impossible scenarios.
    If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

## Surgical Changes

Touch only what you must. Clean up only your own mess.

When editing existing code:

    Don't "improve" adjacent code, comments, or formatting.
    Don't refactor things that aren't broken.
    Match existing style, even if you'd do it differently.
    If you notice unrelated dead code, mention it - don't delete it.

When your changes create orphans:

    Remove imports/variables/functions that YOUR changes made unused.
    Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

## Goal-Driven Execution

Define success criteria. Loop until verified.

Transform tasks into verifiable goals:

    "Add validation" → "Write tests for invalid inputs, then make them pass"
    "Fix the bug" → "Write a test that reproduces it, then make it pass"
    "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:

1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.

# CODING RULES
## Core
- Lang: EN only (code, vars, docs)
- Func: 10–20 lines max
- Files: < 200 lines
- Folders: group by feature
- Modular: separate concerns/files
- Prefer classes
- Clean: readable, low complexity, descriptive names
- reuse funcs and avoid redundancy
- Only do requested task, be self sceptic, not suggest or assume, ask if unclear
- runnable as-is and within Docker
- .env file for sensitive configs
- config.json for non-sensitive config, data models, constants
- no hardcoding of configs, paths, URLs, keys
- microservice approach: frontend, backend, API separated
- use virtual env + requirements.txt
- avoid external dependencies unless necessary
- Group similar funcs in same file
- Spec compliance first: Follow WHATWG HTML5 spec exactly. No heuristics, no shortcuts.
- Python: PEP8 (black)
- JS: ESLint + Prettier
- No reflective probing: No hasattr, getattr, or delattr - all data structures used are deterministic.
- Minimal allocations: Reuse buffers, avoid per-token object creation in tokenizer.
- Token reuse: Create new token objects when emitting (don't reuse references).
- State machine purity: Tokenizer state transitions follow spec state machine exactly.
- No test-specific code: No references to test files in comments or code.
- API responses: Consistent structure: {"status": "success|error", "data": {}, "message": ""}
- Tokenizer is hot path: minimize allocations, avoid string slicing
- Use str.find() for scanning, not regex when possible

## Naming
- Func: descriptive_snake_case
- Files: snake_case.py / kebab-case.js
- Tests: test_[module].py

## Structure

(project folder layout example, adjust according to the particular coding language and environment)

project/
├── app.py
├── config.json
├── .env.example
├── .gitignore
├── requirements.txt
├── Dockerfile
├── docker-compose.yml
├── README.md
├── UNFINISHED.md
├── functions/
│   ├── ui/
│   ├── auth/
│   ├── data/
│   └── api/
│   └── folder.md
├── templates/
│   └── folder.md

├── static/
│   ├── css/
│   ├── js/
│   └── images/
│   └── folder.md
├── tests/{test_ui,test_auth,test_data}/
│   ├── test_ui/
│   ├── test_auth/
│   ├── test_data/
│   └── folder.md
└── utils/
    └── logger.py
    └── folder.md

## Documentation
- plain English only, alphanumeric only, no special chars
- omnipresent docstrings (Google style)
- brief, bulletpoints
- infile and inline comments explain why (spec rationale), not what (code is self-documenting)
- document per file at each file's header, contains: purpose, main funcs, dependendent files
- document per function at each function's header, contains: purpose, input data, output data, process, dependendent functions and classes
- create sections between functions and classes with clear markers within files to seperate concerns, e.g.:
    - Python: `# --- UI OPS ---`
    - HTML: `<!-- --- UI OPS --- -->`
- README.md: brie, bullets points, of three parts:
    - purpose (3 sentences)
    - setup (running locally or in Docker)
    - how to run scripts, start the app or run background functions:
        - list commands, possible entrie points and arguments
        - add one descriptive bullet points per command/entry point
    - Usage Example Format:
```
    ## Usage
    - brief description of usage scenario, when to use this script/app with these arguments

    ```bash
    python app.py --arg1 val1 --arg2 val2
    ```
```
- UNFINISHED.md
    - as soon as the user sends a prompt, add a checklist entry to UNFINISHED.md with:
        - date/time
        - brief description of what is unfinished, current blockers, next steps
    - only the user marks items as done by removing them from the file


## Logging
- plain English only, alphanumeric only, no special chars
- Use utils/logger.py
- "recursive level approach": log on each "branch" of execution tree
- use indention to indicate depth
- levels:
    - 1. Level: app start/end
    - 2. Level: func entry/exit with params
    - 3. Level: before loops/conditionals
    - 4. Level: within loops/conditionals
- Levels: DEBUG, INFO
    - DEBUG 
        - logs all levels and exception errors
        - additionally logs key variable states at key points
    - INFO:
        - logs levels 1 and 2 only and exception errors
- read debug level from .env

## Error Handling
- No exceptions in hot paths: Use deterministic control flow, not try/except for branching.
- Log errors at appropriate levels (see Logging).

Pseudo Code Example:
```python
try:
    [...]
except SpecificError as e:
  log_message(f"Error in X: {e}", level="ERROR")
  return None
```
## Testing
- **Test-Driven Development (TDD) mindset**: Write or plan tests alongside code.
- **Framework**: Use `pytest`.
- **Structure**: Mirror source structure in `/tests` (e.g., `src/auth.py` -> `tests/test_auth.py`).
- **Coverage**: All public functions must be tested. Aim for ≥90% coverage.
- **Integration**: Maintain `/tests/full_test.py` for end-to-end flows, one command: `pytest tests/full_test.py --disable-warnings -q`
- **Mocking**: Mock external APIs and heavy dependencies.
- **Execution**: Ensure `pytest` passes before marking step as complete.
- Run `pytest --maxfail=1 --disable-warnings -q` pre-commit
- Uses Flask test_client for all endpoints (dummy data)
- Runs all funcs with sample inputs
- Mocks external APIs (responses/unittest.mock)
- Dummy data in `/tests/data/`

## Security
- **Input Validation**: Validate all inputs at entry points (API, UI forms).
- **Data Flow**: Ensure data persists correctly to DB/Storage and returns to UI.
- **Error States**: Verify UI handles error responses gracefully.
- **Cross-Layer**: Trace data from UI -> API -> DB -> API -> UI to ensure consistency.
- Param queries only (SQLAlchemy)
- No raw SQL
- Add rate limiting + CSRF protection
- Sanitize filenames on upload
- Use Salt and Pepper when hashing passwords (bcrypt)

## Frontend
- Vanilla JS ES6+, small funcs
- Use modules (import/export)
- No frameworks
- Organize by feature
- plain, compact layout

## Repository and GIT
- always check if git repo exists, if not suggest to create it
- before communicate the task completion, commit
- Commit msg: `[feat|fix|refactor|docs]: short, brief, bullet point description`

## Docker
- Works local + Docker
- Include Docker configs
- Consider containerization in design


