# iOS Build Instructions

This project has been configured for iOS using **Capacitor**.

## Pre-requisites
- **macOS** computer (MacBook, Mac Mini, etc.)
- **Xcode** installed (from the Mac App Store)
- **CocoaPods** installed (`sudo gem install cocoapods`)

## Steps to Build and Release

1.  **Transfer the Project**: Copy this entire project folder to your Mac.
2.  **Install Dependencies**:
    Open a terminal in the project folder and run:
    ```bash
    npm install
    ```
3.  **Sync Assets**:
    Run this command to make sure the latest web build is copied to the iOS project:
    ```bash
    npm run build
    npx cap sync
    ```
4.  **Open in Xcode**:
    Run:
    ```bash
    npx cap open ios
    ```
    This will launch Xcode with your project.

5.  **Run on Simulator**:
    - Select a simulator (e.g., iPhone 15) from the top bar in Xcode.
    - Click the "Play" (Run) button.

6.  **Deploy to App Store**:
    - You will need an **Apple Developer Account** ($99/year).
    - In Xcode, go to the **Signing & Capabilities** tab and sign in with your team.
    - Go to **Product > Archive**.
    - Once archived, use the **Distribute App** button to upload to App Store Connect.

## Troubleshooting
- If you see errors about "CocoaPods", try running:
  ```bash
  cd ios/App
  pod install
  ```
- If you change your React code, always remember to run:
  ```bash
  npm run build
  npx cap sync
  ```
