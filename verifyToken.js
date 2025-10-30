// verifyToken.js (middleware)
import admin from "firebase-admin";

// Verify Firebase token middleware
const verifyToken = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) {
    return res.status(401).send({ message: 'Unauthorized access: No token provided' });
  }

  const token = authHeader.split(' ')[1]; // Get the token after 'Bearer'
  if (!token) {
    return res.status(401).send({ message: 'Unauthorized access: No token provided' });
  }

  try {
    // Verify the token with Firebase Admin SDK
    const decoded = await admin.auth().verifyIdToken(token);
    req.decoded = decoded;  // Attach the decoded user info to the request object
    next();  // Call the next middleware/route handler
  } catch (error) {
    console.error('Token verification error:', error);
    return res.status(403).send({ message: 'Forbidden access: Invalid token' });
  }
};

export default verifyToken;