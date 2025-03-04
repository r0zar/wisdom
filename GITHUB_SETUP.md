# GitHub & npm Setup Guide

This document provides step-by-step instructions for setting up this package on GitHub and publishing it to npm.

## Setting Up GitHub Repository

1. **Create a new GitHub repository**
   - Go to [GitHub](https://github.com)
   - Click "New repository"
   - Name: `wisdom`
   - Description: "Core business logic and data access layer for prediction markets"
   - Set visibility as needed (public or private)
   - Do not initialize with README, .gitignore, or license (we already have these)
   - Click "Create repository"

2. **Push existing code to GitHub**
   ```bash
   # Navigate to your project directory if not already there
   cd /path/to/wisdom
   
   # Initialize git repository if not already done
   git init
   
   # Add all files
   git add .
   
   # Create initial commit
   git commit -m "Initial commit"
   
   # Add remote repository
   git remote add origin https://github.com/r0zar/wisdom.git
   
   # Push to GitHub
   git push -u origin main
   ```

3. **Update repository URLs in package.json**
   - After creating the repository, update these fields in package.json:
     ```json
     "repository": {
       "type": "git",
       "url": "https://github.com/r0zar/wisdom.git"
     },
     "homepage": "https://github.com/r0zar/wisdom#readme",
     "bugs": {
       "url": "https://github.com/r0zar/wisdom/issues"
     }
     ```

## Setting Up npm Publishing

1. **Create an npm account**
   - If you don't have one, go to [npm](https://www.npmjs.com/signup)
   - Follow the registration process

2. **Login to npm from command line**
   ```bash
   npm login
   ```

3. **Generate npm access token for GitHub Actions**
   - Go to npm account settings
   - Select "Access Tokens"
   - Create a new token with "Read and publish" permissions
   - Copy the token - it will only be shown once

4. **Add npm token to GitHub repository secrets**
   - Go to your GitHub repository
   - Click "Settings" > "Secrets and variables" > "Actions"
   - Click "New repository secret"
   - Name: `NPM_TOKEN`
   - Value: (paste the npm token you copied)
   - Click "Add secret"

## Publishing Process

### Manual Publishing

1. Build the package locally:
   ```bash
   pnpm build
   ```

2. Test the package:
   ```bash
   pnpm test
   ```

3. Publish to npm:
   ```bash
   pnpm publish
   ```

### Automatic Publishing via GitHub Actions

1. **Create a new GitHub release**
   - Go to your GitHub repository
   - Click "Releases" > "Create a new release"
   - Choose a tag version matching package.json (e.g., v2.0.0)
   - Title: "v2.0.0"
   - Description: Copy relevant sections from CHANGELOG.md
   - Click "Publish release"

2. **Monitor GitHub Actions**
   - The release will trigger the publish workflow
   - Go to "Actions" tab in your repository to monitor the progress

## Maintaining the Repository

### Versioning

1. Update version in package.json:
   ```json
   "version": "2.1.0"
   ```

2. Update CHANGELOG.md with new changes

3. Commit these changes:
   ```bash
   git add package.json CHANGELOG.md
   git commit -m "chore: bump version to 2.1.0"
   git push
   ```

4. Create a new GitHub release with the new version

### Branch Protection (Recommended)

1. Go to "Settings" > "Branches"
2. Click "Add rule"
3. Branch name pattern: `main`
4. Enable "Require pull request reviews before merging"
5. Enable "Require status checks to pass before merging"
6. Select the CI workflow as a required status check
7. Click "Create"