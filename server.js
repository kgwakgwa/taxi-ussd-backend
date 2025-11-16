const express = require('express');
const bodyParser = require('body-parser');

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

const sessions = {};
const trips = {};
let tripCounter = 1;

function atResponse(message, end=false) {
  return (end ? "END " : "CON ") + message;
}

app.post('/ussd', (req, res) => {
  const { sessionId="", serviceCode, phoneNumber="", text="" } = req.body;
  const userInput = text.trim();
  const inputs = userInput === "" ? [] : userInput.split('*');

  if (!sessions[sessionId]) {
    sessions[sessionId] = { phone: phoneNumber, data: {} };
  }

  if (inputs.length === 0) {
    return res.send(atResponse(
      "Welcome to QuickRide\n1. Request Taxi\n2. Check Trip Status\n3. Cancel Trip"
    ));
  }

  if (inputs[0] === "1") {
    if (inputs.length === 1) {
      return res.send(atResponse("Select Town:\n1. Zeerust\n2. Mahikeng\n0. Back"));
    }

    if (inputs.length === 2) {
      const town = inputs[1] === "1" ? "Zeerust" : "Mahikeng";
      sessions[sessionId].data.town = town;

      if (town === "Zeerust") {
        return res.send(atResponse("Pickup (Zeerust):\n1. Zeerust CBD\n2. Ikageleng\n3. Henryville\n0. Back"));
      } else {
        return res.send(atResponse("Pickup (Mahikeng):\n1. Mahikeng CBD\n2. Mmabatho\n3. Danville\n0. Back"));
      }
    }

    if (inputs.length === 3) {
      const town = sessions[sessionId].data.town;
      const pickOpt = inputs[2];

      const pickMap = {
        Zeerust: { "1": "Zeerust CBD", "2": "Ikageleng", "3": "Henryville" },
        Mahikeng: { "1": "Mahikeng CBD", "2": "Mmabatho", "3": "Danville" }
      };

      sessions[sessionId].data.pickup = pickMap[town][pickOpt] || "Unknown";

      return res.send(atResponse(
        `Select Drop-off:\n1. ${sessions[sessionId].data.pickup}\n2. Other\n0. Back`
      ));
    }

    if (inputs.length === 4) {
      const drop = inputs[3] === "1" ? sessions[sessionId].data.pickup : "Other";
      sessions[sessionId].data.dropoff = drop;

      return res.send(atResponse(
        `Confirm Trip:\nFrom: ${sessions[sessionId].data.pickup}\nTo: ${drop}\nFare: R25-R30\n1. Confirm\n2. Cancel`
      ));
    }

    if (inputs.length === 5) {
      if (inputs[4] === "1") {
        const tid = `TR-${tripCounter++}`;
        trips[tid] = {
          id: tid,
          phone: sessions[sessionId].phone,
          pickup: sessions[sessionId].data.pickup,
          dropoff: sessions[sessionId].data.dropoff,
          status: "searching"
        };

        return res.send(atResponse(`Trip started. Trip ID: ${tid}`, true));
      } else {
        return res.send(atResponse("Cancelled.", true));
      }
    }
  }

  if (inputs[0] === "2") {
    if (inputs.length === 1) return res.send(atResponse("Enter Trip ID:"));

    const t = trips[inputs[1]];
    if (!t) return res.send(atResponse("Trip not found.", true));

    return res.send(atResponse(`Trip ${t.id} Status: ${t.status}`, true));
  }

  if (inputs[0] === "3") {
    if (inputs.length === 1) return res.send(atResponse("Enter Trip ID to cancel:"));

    if (trips[inputs[1]]) trips[inputs[1]].status = "cancelled";

    return res.send(atResponse("Cancelled.", true));
  }

  return res.send(atResponse("Invalid option.", true));
});

app.get('/', (req, res) => {
  res.send("QuickRide backend running.");
});

const port = process.env.PORT || 10000;
app.listen(port, () => console.log("Server running on port " + port));
