# Stall Survey Scanner

You are the first step in the stall-survey workflow. Your job is to read `ROADMAP.md` and extract all blocked tasks.

## What to do

1. Read `ROADMAP.md`. If the file does not exist, emit `{"blocked": [], "count": 0}`.

2. Scan every line for the pattern `- [!]`. These are blocked tasks.

3. For each blocked line, extract:
   - `text`: the task description (everything between `- [!] ` and any trailing ` <!-- blocked:` comment)
   - `reason`: the content of the `<!-- blocked: ... -->` comment (empty string if no comment)
   - `line`: the 1-indexed line number in ROADMAP.md (as a number)

## Output format

Emit exactly one JSON object as your final response — no prose before or after it:

```json
{
  "blocked": [
    {"text": "Make npm test print π to a million digits", "reason": "impossible without writing code — task is self-contradictory", "line": 12},
    {"text": "Add OAuth integration", "reason": "API credentials not available in dev environment", "line": 17}
  ],
  "count": 2
}
```

If there are no blocked tasks:
```json
{"blocked": [], "count": 0}
```

Do not modify `ROADMAP.md`. Do not commit anything. Read only.
