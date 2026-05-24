import { initializeApp } from "firebase/app";
import { getAuth } from "firebase/auth";

const firebaseConfig = {
  apiKey: "AIzaSyDj3zk2BlAqxmt3Ad-QosdwRqYsyXYSuFo",
  authDomain: "login-6ea19.firebaseapp.com",
  projectId: "login-6ea19",
  storageBucket: "login-6ea19.firebasestorage.app",
  messagingSenderId: "387293070277",
  appId: "1:387293070277:web:e94f4839ec35df3c3901ac",
};

const app = initializeApp(firebaseConfig);

export const auth = getAuth(app);
