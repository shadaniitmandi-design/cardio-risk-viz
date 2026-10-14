# CardioViz

CardioViz is an educational cardiovascular risk visualization demo. It combines a clinical-input interface, browser-side model inference, approximate feature-contribution explanations, and an interactive 3D anatomical heart.

**For educational and research use only. It is not a medical device and must not be used for diagnosis, treatment, or clinical decision-making.**

## Live site

The GitHub Pages deployment is published from the `main` branch by the workflow in `.github/workflows/pages.yml`.

## Deploy to GitHub Pages

1. Create a public repository named `cardio-risk-viz`.
2. Push this folder's contents to its `main` branch.
3. In the repository settings, set Pages' build and deployment source to **GitHub Actions** if it is not enabled automatically.
4. The Pages workflow publishes the root of this repository after each push to `main`.

The asset URLs are relative, so the project works at the GitHub Pages project URL (`/<repository>/`) as well as at a static host's domain root. Prediction models and the 3D heart asset are downloaded by the browser from this repository.

## Project contents

- `index.html` and `static/css/`: the CardioViz frontend
- `static/js/`: interface, browser-side model runtime, and Three.js heart viewer
- `static/ml/`: exported model bundles and feature metadata
- `static/models/heart.glb`: 3D heart asset

This deployment contains only static frontend assets; it does not include the source dataset, Python training environment, or Flask API.
