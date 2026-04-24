# Render deployment

This deployment keeps Monday sync enabled.

## Create the service

1. Push this repo to GitHub.
2. In Render, click New + > Web Service.
3. Connect the `onboarding` repo.
4. Render will detect `render.yaml` automatically.
5. Add the environment variable `MONDAY_API_TOKEN` in Render.
6. Deploy.

## Important

- Use the hosted Render URL for live Monday-connected testing.
- Keep GitHub Pages as the safe demo-only version.
- The frontend already uses same-origin requests, so no extra API URL wiring is needed.
