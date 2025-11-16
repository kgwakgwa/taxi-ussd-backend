const express = require("express");
const bodyParser = require("body-parser");
const fs = require("fs");
const path = require("path");
const csv = require("csv-parser");

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

// --- In-memory storage ---
const sessions = {};
const trips = {};
let tripCounter = 1;

// --- Load locations from CSV ---
const locations = [];
fs.createReadStream(path.join(__dirname, "data", "locations.csv"))
  .pipe(csv())
  .on("data", (row) => {
    locations.push({ town: row.town, name: row.location });
  })
  .on("end", () => {
    console.log(`Loaded ${locations.length} locations from CSV`);
  });

// --- Approximate distance (km) between towns ---
// For simplicity, distances are approximate between main towns
const distanceMap = {
  "Zeerust": { "Mahikeng": 30, "Lehurutshe": 25, "Dinkokana": 28, "Mokgola": 15, "Autumn Leaves Mall": 5, "Lekubu": 20 },
  "Mahikeng": { "Zeerust": 30, "Lehurutshe": 15, "Dinkokana": 10, "Mokgola": 18, "Autumn Leaves Mall": 8, "Lekubu": 12 },
  "Lehurutshe": { "Zeerust": 25, "Mahikeng": 15, "Dinkokana": 12, "Mokgola": 10, "Autumn Leaves Mall": 6, "Lekubu": 8 },
  "Dinkokana": { "Zeerust": 28, "Mahikeng": 10, "Lehurutshe": 12, "Mokgola": 14, "Autumn Leaves Mall": 7, "Lekubu": 9 },
  "Mokgola": { "Zeerust": 15, "Mahikeng": 18, "Lehurutshe": 10, "Dinkokana": 14, "Autumn Leaves Mall": 5, "Lekubu": 8 },
  "Autumn Leaves Mall": { "Zeerust": 5, "Mahikeng": 8, "Lehurutshe": 6, "Dinkokana": 7, "Mokgola": 5, "Lekubu": 4 },
  "Lekubu": { "Zeerust": 20, "Mahikeng": 12, "Lehurutshe": 8, "Dinkokana": 9, "Mokgola": 8, "Autumn Leaves Mall": 4 }
};

// --- Fare calculation ---
function calculateFare(distanceKm) {
  if (distanceKm <= 5) return "R25 - R50";
  if (distanceKm <= 10) return "R50 - R70";
  if (distanceKm <= 20) return "R70 - R85";
  if (distanceKm <= 30) return "R85 - R100";
  return "R100+"; // fallback
}

// --- Helper for USSD responses ---
function atResponse(message, end = false) {
  return (end ? "END " : "CON ") + message;
}

// --- USSD endpoint ---
app.post("/ussd", (req, res) => {
  const { sessionId = "", phoneNumber = "", text = "" } = req.body;
  const userText = text.trim();
  const inputs = userText === "" ? [] : userText.split("*");

  // Initialize session
  if (!sessions[sessionId]) sessions[sessionId] = { phoneNumber, step: "MAIN", data: {} };
  const session = sessions[sessionId];

  // --- Step 1: Main Menu
  if (inputs.length === 0) {
    return res.send(atResponse(
      "Welcome to QuickRide\n1. Request Taxi\n2. Check Trip Status\n3. Cancel Trip"
    ));
  }

  // --- Step 2: Request Taxi Flow
  if (inputs[0] === "1") {
    // Step 2a: Pick-up selection
    if (inputs.length === 1) {
      let menu = "Select Pickup Location:\n";
      locations.forEach((loc, i) => {
        menu += `${i + 1}. ${loc.name}\n`;
      });
      menu += "0. Back";
      return res.send(atResponse(menu));
    }

    // Step 2b: Drop-off selection
    if (inputs.length === 2) {
      const pickIndex = parseInt(inputs[1], 10) - 1;
      if (!locations[pickIndex]) return res.send(atResponse("Invalid pickup. Try again.", true));
      session.data.pickup = locations[pickIndex].name;
      session.data.pickupTown = locations[pickIndex].town;

      let menu = "Select Drop-off Location:\n";
      locations.forEach((loc, i) => {
        menu += `${i + 1}. ${loc.name}\n`;
      });
      menu += "0. Back";
      return res.send(atResponse(menu));
    }

    // Step 2c: Confirm trip and calculate fare
    if (inputs.length === 3) {
      const dropIndex = parseInt(inputs[2], 10) - 1;
      if (!locations[dropIndex]) return res.send(atResponse("Invalid drop-off. Try again.", true));
      session.data.dropoff = locations[dropIndex].name;
      session.data.dropoffTown = locations[dropIndex].town;

      // Estimate distance between towns
      let dist = 5; // default if same town
      if (session.data.pickupTown !== session.data.dropoffTown) {
        const map = distanceMap[session.data.pickupTown];
        dist = map ? (map[session.data.dropoffTown] || 10) : 10;
      }

      const fare = calculateFare(dist);

      return res.send(atResponse(
        `Confirm Trip:\nFrom: ${session.data.pickup}\nTo: ${session.data.dropoff}\nEstimated Fare: ${fare}\n1. Confirm\n2. Cancel`
      ));
    }

    // Step 2d: Final confirmation
    if (inputs.length === 4) {
      if (inputs[3] === "1") {
        const tid = `TR-${tripCounter++}`;
        trips[tid] = {
          id: tid,
          phone: session.phoneNumber,
          pickup: session.data.pickup,
          dropoff: session.data.dropoff,
          status: "searching"
        };
        return res.send(atResponse(`Trip confirmed! Trip ID: ${tid}`, true));
      } else {
        return res.send(atResponse("Trip cancelled.", true));
      }
    }
  }

  // --- Step 3: Check Trip Status
  if (inputs[0] === "2") {
    if (inputs.length === 1) return res.send(atResponse("Enter Trip ID:"));
    const t = trips[inputs[1]];
    if (!t) return res.send(atResponse("Trip not found.", true));
    return res.send(atResponse(`Trip ${t.id} status: ${t.status}`, true));
  }

  // --- Step 4: Cancel Trip
  if (inputs[0] === "3") {
    if (inputs.length === 1) return res.send(atResponse("Enter Trip ID to cancel:"));
    if (trips[inputs[1]]) trips[inputs[1]].status = "cancelled";
    return res.send(atResponse("Trip cancelled.", true));
  }

  return res.send(atResponse("Invalid option.", true));
});

// --- Health check ---
app.get("/", (req, res) => res.send("QuickRide backend running"));

// --- Start server ---
const port = process.env.PORT || 10000;
app.listen(port, () => console.log(`Server running on port ${port}`));
