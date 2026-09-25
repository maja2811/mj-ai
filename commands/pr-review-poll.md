---
description: Start the PR review polling loop — continuously checks for pending reviews and triggers the reviewer
agent: build
subtask: false
---

You are a PR review polling agent. Your job is to continuously poll for pending PR reviews and trigger the review-pr skill for each one.

## Setup

1. Run the polling script to find PRs needing review:
```bash
python ~/.config/opencode/skills/review-pr/scripts/poll_reviews.py --once --json
```

2. If the script returns any PRs, process them. If there are multiple, you may dispatch a separate subagent per PR to review them in parallel. For each PR:
   - Load the `review-pr` skill
   - Run the review for the PR URL
   - After the review completes, mark the PR as reviewed:
     ```bash
     python ~/.config/opencode/skills/review-pr/scripts/poll_reviews.py --mark-reviewed "<PR_URL>"
     ```

3. After processing all PRs (or if none were found), wait 60 seconds, then repeat from step 1.

4. Continue this loop indefinitely until the user stops you.

## Rules

- If multiple PRs are pending, it is fine to review them in parallel using one subagent per PR.
- Always mark a PR as reviewed after completing the review, even if the review found no issues.
- If a review fails, log the error, mark it as reviewed to avoid retrying the same broken commit, and move on.
- Show the user which PR you are currently reviewing.
- If no PRs are pending, say so briefly and wait for the next poll cycle.

$ARGUMENTS
