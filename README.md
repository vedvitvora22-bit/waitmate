# 🍽️ WaitMate — Smart Restaurant Queue & Waitlist Management

**WaitMate** is a real-time restaurant queue and waitlist web application built as part of the **9th Edition of the Young Innovators Internship Challenge (YIIC 9)** by **Scaler School of Technology**. 

It eliminates the guesswork and physical crowding at busy restaurants by giving diners live queue tracking and giving restaurant hosts a streamlined digital dashboard.

🔗 **Live Demo:** [waitmate-weld.vercel.app](https://vercel.app)

---

## ✨ Key Features

### 👤 For Diners (Customer Experience)
* **Browse & Join Queues:** View participating restaurants and join the digital waitlist in seconds.
* **Dynamic Wait-Time Estimates:** Real-time wait calculations based on current queue size and table turnover (capped realistically to keep expectations transparent).
* **Live Digital Boarding Pass:** Track your live queue position, confirm arrival to notify the host, and share a read-only live pass with friends via WhatsApp or a direct link.

### 🏪 For Restaurant Owners (Host Stand)
* **Password-Protected Dashboard:** Secure, restaurant-specific host stand access to prevent unauthorized edits.
* **Live Queue Management:** View incoming guests, party sizes, and arrival confirmations in real time.
* **One-Click Seating & Turnover:** Mark guests as seated or manage queue flow seamlessly without manual paper logs.

### 🛡️ Platform & Founder Controls
* **Role-Based Access:** Dedicated founder controls to onboard and manage registered restaurants cleanly.

---

## 🛠️ Tech Stack

* **Frontend:** HTML5, CSS3, JavaScript *(or React/Next.js — update to match your exact setup)*
* **Backend & Real-Time Database:** Firebase / Firestore
* **Deployment:** Vercel

---

## 🚀 Getting Started (Run Locally)

To run a local copy of this project on your machine:

1. **Clone the repository**
   ```bash
   git clone https://github.com
   cd YOUR-REPO-NAME
   ```

2. **Configure Firebase**
   * Create a project in the [Firebase Console](https://google.com).
   * Enable **Cloud Firestore** and set up your security rules.
   * Add your Firebase configuration keys to your config file or `.env` file.

3. **Launch the App**
   * If using plain HTML/JS: Open `index.html` with VS Code Live Server (or run `python3 -m http.server`).
   * If using Node/React: Run `npm install` followed by `npm run dev`.

---

## 🏆 Built For
**Young Innovators Internship Challenge — 9th Edition (YIIC 9)**  
Organized by **Scaler School of Technology**
