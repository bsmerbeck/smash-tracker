## Smash Tracker

Smash tracker is an application that allows users to track their match statistics in Super Smash Bros. Ultimate.

The tracker uses Google Firebase for hosting, database/backend functions, and user authentication.

### Features

- Login using email/password or Google
- Selection of Primary and Secondary Fighters
- Win/Loss tracker for matches
- Analytics for fighter

### Running Smash Tracker

To run Smash Tracker, you'll need to create a Google firebase account. The project uses the following features.

- Authentication: allows email + Google sign in and sign up
- Realtime Database: storing authentication information and all entered data (matches)
- Hosting: hosts the app, so it is accessible online
- Cloud Functions: perform backend operations (creating DB nodes for users on sign up)

```
git clone https://github.com/bsmerbeck/smash-tracker.git
cd smash-tracker
yarn install
```

To set up firebase, refer to the documentation available here: https://firebase.google.com/docs/web/setup

Once you've set up your project, create a file `firebase.js` in `/src`.

You'll then need to populate the file with your specific firebase details like so:

```jsx
import firebase from "firebase/app";
import "firebase/auth";
import "firebase/database";

export const firebaseConfig = {
  apiKey: "your-key-here",
  authDomain: "your-app.firebase.app",
  databaseURL: "https://your-app.firebaseio.com",
  projectId: "your-project-id",
  storageBucket: "your-storage-bucket",
  messagingSenderId: "your-message-sender-id",
  appId: "your-app-id",
  measurementId: "your-measurement-id",
};

firebase.initializeApp(firebaseConfig);
```

To deploy changes, you'll need to setup the Firebase CLI: https://firebase.google.com/docs/cli

### Current Status

This project is currently under development. As such, it should be noted that many elements are nonfunctional.

### Disclaimer

I do not claim any rights to the content of the application. All rights belong to Nintendo, and are not used for any commercial purpose.
