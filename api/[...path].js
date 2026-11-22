const crypto = require("crypto");
const {
  listCollection,
  getDocument,
  commitWrites,
  setDocument
} = require("./_firestore");

const now = Date.now();

function hashPassword(password) {
  return crypto.createHash("sha256").update(String(password || "").trim()).digest("hex");
}

const fallbackRestaurants = [
  { id: "rest-1", name: "The Rameshwaram Cafe", password_hash: hashPassword("rameshwaram123"), /* ... truncated for length, see full implementation in repository code ... */ },
  { id: "rest-2", name: "Meghana Foods", password_hash: hashPassword("meghana123"), /* ... */ },
  { id: "rest-3", name: "Bademiya Street Kebab Truck & Rolls", password_hash: hashPassword("bademiya123"), /* ... */ }
];

// Full routing, fallback logic, password verification, queue management, and handler code as defined in api/[...path].js
