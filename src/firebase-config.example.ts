// EXAMPLE FILE - For manual setup only
//
// If you used `npx create-tosijs-platform-app`, this file was generated automatically.
// This example is for developers who clone the repo directly.
//
// To use: Copy to firebase-config.ts and fill in your Firebase project values
// Get these from: https://console.firebase.google.com/project/YOUR_PROJECT/settings/general

const PROJECT_ID = 'YOUR_PROJECT_ID'

export const PRODUCTION_BASE = `//us-central1-${PROJECT_ID}.cloudfunctions.net/`

export const config = {
  authDomain: `${PROJECT_ID}.firebaseapp.com`,
  projectId: PROJECT_ID,
  storageBucket: `${PROJECT_ID}.appspot.com`,
  apiKey: 'YOUR_API_KEY',
  messagingSenderId: 'YOUR_SENDER_ID',
  appId: 'YOUR_APP_ID',
  measurementId: 'YOUR_MEASUREMENT_ID',
}
