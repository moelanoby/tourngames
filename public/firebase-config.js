/**
 * Firebase Configuration for TournGames
 * 
 * Get these values from Firebase Console:
 * Project Settings → General → Your apps → Web app (</> icon)
 * 
 * IMPORTANT: Never commit your actual API keys to a public repo!
 * For GitHub Pages, you have a few options:
 * 1. Use environment variables at build time (GitHub Actions)
 * 2. Create a separate config file that's gitignored
 * 3. Use Firebase's authorized domains to restrict API key usage
 */

// TODO: Replace with your actual Firebase config
const firebaseConfig = {
  apiKey: "YOUR_API_KEY",
  authDomain: "your-project.firebaseapp.com",
  databaseURL: "https://your-project-default-rtdb.firebaseio.com",
  projectId: "your-project",
  storageBucket: "your-project.appspot.com",
  messagingSenderId: "123456789",
  appId: "1:123456789:web:abcdef123456"
};

// Export for modules
window.firebaseConfig = firebaseConfig;
