const express = require("express");
const bodyParser = require("body-parser");
const fs = require("fs");
const csv = require("csv-parser");

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

// In-memory session storage
const sessions = {};
const trips = {};
let tripCounter = 1;

// Load all locations from CSV at startup
// CSV format assumed: town,location
const locations = [];
fs.createReadStream("data/locations.csv")
  .pipe(csv())
  .on("data", (row) => {
    // Expect row.town and row.location
    locations.push({ town: row.town, name: row.location });
  })
  .on("end", () => {
    console.log(`Loaded ${locations.length} locations from CSV`);
  });

// Helper function for USSD response
function atResponse(message, end = false) {
  return (end ? "END " : "CON ") + message;
}

// --- USSD endpoint
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

      let menu = "Select Drop-off Location:\n";
      locations.forEach((loc, i) => {
        menu += `${i + 1}. ${loc.name}\n`;
      });
      menu += "0. Back";
      return res.send(atResponse(menu));
    }

    // Step 2c: Confirm trip
    if (inputs.length === 3) {
      const dropIndex = parseInt(inputs[2], 10) - 1;
      if (!locations[dropIndex]) return res.send(atResponse("Invalid drop-off. Try again.", true));
      session.data.dropoff = locations[dropIndex].name;

      // Estimated fare stub
      const estimatedFare = "R25 - R50";

      return res.send(atResponse(
        `Confirm Trip:\nFrom: ${session.data.pickup}\nTo: ${session.data.dropoff}\nEstimated Fare: ${estimatedFare}\n1. Confirm\n2. Cancel`
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

// Simple health check
app.get("/", (req, res) => res.send("QuickRide backend running"));

// Start server
const port = process.env.PORT || 10000;
app.listen(port, () => console.log(`Server running on port ${port}`));
