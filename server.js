const express = require("express");
const bodyParser = require("body-parser");
const fs = require("fs");
const path = require("path");
const csv = require("csv-parser");
const cors = require("cors");   // ✅ ADD THIS

const app = express();

// ✅ Enable CORS for all frontend domains
app.use(cors({
  origin: "*",
  methods: ["GET", "POST", "PUT", "DELETE"],
  allowedHeaders: ["Content-Type"]
}));

app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

// --- In-memory storage ---
const sessions = {};
const trips = {};
const drivers = {};
let tripCounter = 1;
let driverCounter = 1;

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

// --- Distance Map ---
const distanceMap = {
  "Zeerust": { "Mahikeng": 30, "Lehurutshe": 25, "Dinkokana": 28, "Mokgola": 15, "Autumn Leaves Mall": 5, "Lekubu": 20 },
  "Mahikeng": { "Zeerust": 30, "Lehurutshe": 15, "Dinkokana": 10, "Mokgola": 18, "Autumn Leaves Mall": 8, "Lekubu": 12 },
  "Lehurutshe": { "Zeerust": 25, "Mahikeng": 15, "Dinkokana": 12, "Mokgola": 10, "Autumn Leaves Mall": 6, "Lekubu": 8 },
  "Dinkokana": { "Zeerust": 28, "Mahikeng": 10, "Lehurutshe": 12, "Mokgola": 14, "Autumn Leaves Mall": 7, "Lekubu": 9 },
  "Mokgola": { "Zeerust": 15, "Mahikeng": 18, "Lehurutshe": 10, "Dinkokana": 14, "Autumn Leaves Mall": 5, "Lekubu": 8 },
  "Autumn Leaves Mall": { "Zeerust": 5, "Mahikeng": 8, "Lehurutshe": 6, "Dinkokana": 7, "Mokgola": 5, "Lekubu": 4 },
  "Lekubu": { "Zeerust": 20, "Mahikeng": 12, "Lehurutshe": 8, "Dinkokana": 9, "Mokgola": 8, "Autumn Leaves Mall": 4 }
};

function calculateFare(distanceKm) {
  if (distanceKm <= 5) return "R25 - R50";
  if (distanceKm <= 10) return "R50 - R70";
  if (distanceKm <= 20) return "R70 - R85";
  if (distanceKm <= 30) return "R85 - R100";
  return "R100+";
}

function atResponse(message, end = false) {
  return (end ? "END " : "CON ") + message;
}

// ---------------- USSD --------------------
app.post("/ussd", (req, res) => {
  const { sessionId = "", phoneNumber = "", text = "" } = req.body;
  const userText = text.trim();
  const inputs = userText === "" ? [] : userText.split("*");

  if (!sessions[sessionId]) sessions[sessionId] = { phoneNumber, step: "MAIN", data: {} };
  const session = sessions[sessionId];

  if (inputs.length === 0) {
    return res.send(atResponse(
      "Welcome to QuickRide\n1. Request Taxi\n2. Check Trip Status\n3. Cancel Trip"
    ));
  }

  if (inputs[0] === "1") {
    if (inputs.length === 1) {
      let menu = "Select Pickup Location:\n";
      locations.forEach((loc, i) => (menu += `${i + 1}. ${loc.name}\n`));
      menu += "0. Back";
      return res.send(atResponse(menu));
    }

    if (inputs.length === 2) {
      const pickIndex = parseInt(inputs[1], 10) - 1;
      if (!locations[pickIndex]) return res.send(atResponse("Invalid pickup.", true));
      session.data.pickup = locations[pickIndex].name;
      session.data.pickupTown = locations[pickIndex].town;

      let menu = "Select Drop-off Location:\n";
      locations.forEach((loc, i) => (menu += `${i + 1}. ${loc.name}\n`));
      menu += "0. Back";
      return res.send(atResponse(menu));
    }

    if (inputs.length === 3) {
      const dropIndex = parseInt(inputs[2], 10) - 1;
      if (!locations[dropIndex]) return res.send(atResponse("Invalid drop-off.", true));
      session.data.dropoff = locations[dropIndex].name;
      session.data.dropoffTown = locations[dropIndex].town;

      let dist = 5;
      if (session.data.pickupTown !== session.data.dropoffTown) {
        const map = distanceMap[session.data.pickupTown];
        dist = map ? (map[session.data.dropoffTown] || 10) : 10;
      }
      const fare = calculateFare(dist);

      return res.send(atResponse(
        `Confirm Trip:\nFrom: ${session.data.pickup}\nTo: ${session.data.dropoff}\nEstimated Fare: ${fare}\n1. Confirm\n2. Cancel`
      ));
    }

    if (inputs.length === 4) {
      if (inputs[3] === "1") {
        const tid = `TR-${tripCounter++}`;
        trips[tid] = {
          id: tid,
          phone: session.phoneNumber,
          pickup: session.data.pickup,
          dropoff: session.data.dropoff,
          pickupTown: session.data.pickupTown,
          dropoffTown: session.data.dropoffTown,
          fare: calculateFare(5),
          status: "pending",
          driverId: null
        };
        return res.send(atResponse(`Trip confirmed! Trip ID: ${tid}`, true));
      }
      return res.send(atResponse("Trip cancelled.", true));
    }
  }

  if (inputs[0] === "2") {
    if (inputs.length === 1) return res.send(atResponse("Enter Trip ID:"));
    const t = trips[inputs[1]];
    if (!t) return res.send(atResponse("Trip not found.", true));
    return res.send(atResponse(`Trip ${t.id} status: ${t.status}`, true));
  }

  if (inputs[0] === "3") {
    if (inputs.length === 1) return res.send(atResponse("Enter Trip ID:"));
    if (trips[inputs[1]]) trips[inputs[1]].status = "cancelled";
    return res.send(atResponse("Trip cancelled.", true));
  }

  return res.send(atResponse("Invalid option.", true));
});

// ---------------- DRIVER ENDPOINTS --------------------

app.post("/driver/register", (req, res) => {
  const { name, idNumber, phone } = req.body;
  if (!name || !idNumber || !phone)
    return res.status(400).json({ error: "All fields required" });

  const driverId = `DR-${driverCounter++}`;
  drivers[driverId] = { name, idNumber, phone, loggedIn: false };

  return res.json({ message: "Driver registered", driverId });
});

app.post("/driver/login", (req, res) => {
  const { phone } = req.body;
  const entry = Object.entries(drivers).find(([id, d]) => d.phone === phone);
  if (!entry) return res.status(400).json({ error: "Driver not found" });

  const [driverId, driver] = entry;
  driver.loggedIn = true;

  return res.json({ message: "Login successful", driverId, name: driver.name });
});

app.get("/driver/trips/pending", (req, res) => {
  const pending = Object.values(trips).filter(t => t.status === "pending" && !t.driverId);
  return res.json(pending);
});

app.post("/driver/trips/:id/accept", (req, res) => {
  const { driverId } = req.body;
  const trip = trips[req.params.id];
  if (!trip) return res.status(404).json({ error: "Trip not found" });
  if (trip.driverId) return res.status(400).json({ error: "Trip already taken" });

  trip.driverId = driverId;
  trip.status = "accepted";
  return res.json({ message: "Trip accepted", trip });
});

app.post("/driver/trips/:id/decline", (req, res) => {
  const trip = trips[req.params.id];
  if (!trip) return res.status(404).json({ error: "Trip not found" });

  return res.json({ message: "Trip declined" });
});

app.post("/driver/trips/:id/update", (req, res) => {
  const { status } = req.body;
  const trip = trips[req.params.id];
  if (!trip) return res.status(404).json({ error: "Trip not found" });

  if (!["pickedup", "completed", "cancelled"].includes(status))
    return res.status(400).json({ error: "Invalid status" });

  trip.status = status;
  return res.json({ message: "Trip updated", trip });
});

// Health check
app.get("/", (req, res) => res.send("QuickRide backend running"));

// Start Server
const port = process.env.PORT || 10000;
app.listen(port, () => console.log(`Server running on port ${port}`));
