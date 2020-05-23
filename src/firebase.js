import firebase from "firebase/app";

export const firebaseConfig = {
  apiKey: "AIzaSyCmkngLsTogo2890sCYivh6hovi3hR73c0",
  authDomain: "smash-tracker-f97b7.firebaseapp.com",
  databaseURL: "https://smash-tracker-f97b7.firebaseio.com",
  projectId: "smash-tracker-f97b7",
  storageBucket: "smash-tracker-f97b7.appspot.com",
  messagingSenderId: "781901075636",
  appId: "1:781901075636:web:7705ecac4edbe65c1973e1",
  measurementId: "G-YTY3X1J63M",
};

firebase.initializeApp(firebaseConfig);
firebase.firestore();
