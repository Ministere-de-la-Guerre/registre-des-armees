General Instructions
- When writing commit messages, NEVER auto-add your agent name as co-author
- When making technical decisions, do not give much weight to development cost. 
Instead, prefer quality, simplicity, robustness, scalability, and long term maintainability.
- When doing bug fixes, always start with reproducing the bug in an E2E setting as closely aligned with how an end user would see it. This makes sure you find the real problem so your fix will actually solve it. 
- When end-to-end testing a product, be picky about the UI you see and be obsessed with pixel perfection. If something clearly looks off, even if it is not directly related to what you are doing, try to get it fixed along. 
- Apply that same high standard to engineering excellence: lint, test failures, and test flakiness. If you see one, even if it is not caused by what you are working on right now, still get it fixed. 

Project Specific Instructions
- To find a file, first read docs/AI_FILEMAP.md. Keep this file updated if you change the files of the project.
- docs/HANDOFF.md is the authoritative reference for architecture, rules math, build channels (stable vs beta), and the release workflow. Read it before drafting a version for release.
- When I ask for a version bump, automatically commit the bump afterwards without asking. Use a "Release v<version>" commit message.