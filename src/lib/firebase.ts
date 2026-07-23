import { initializeApp, getApp, getApps } from "firebase/app";
import { getAnalytics, isSupported, Analytics } from "firebase/analytics";
import { getFirestore } from "firebase/firestore";
import { getAuth } from "firebase/auth";

const firebaseConfig = {
  apiKey: "AIzaSyCsfgCs3EKV1xhrPSwHoxWElBOqJu70Z4k",
  authDomain: "tool-video-dubbin.firebaseapp.com",
  projectId: "tool-video-dubbin",
  storageBucket: "tool-video-dubbin.firebasestorage.app",
  messagingSenderId: "965431060099",
  appId: "1:965431060099:web:2df350e931f9197ed31db6",
  measurementId: "G-WDSQ9DS5XV"
};

// Initialize Firebase
const app = getApps().length === 0 ? initializeApp(firebaseConfig) : getApp();
const db = getFirestore(app);
const auth = getAuth(app);

let analytics: Analytics | null = null;

if (typeof window !== "undefined") {
  isSupported().then((supported) => {
    if (supported) {
      analytics = getAnalytics(app);
      console.log("[Firebase] Analytics initialized successfully.");
    }
  });
}

export { app, db, auth, analytics };

