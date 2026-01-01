const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const nodemailer = require("nodemailer");

const app = express();

// ==================== MIDDLEWARE ====================
app.use(
  cors({
    origin: ["http://localhost:3000", "http://localhost:5173"],
    credentials: true,
  })
);
app.use(express.json());

// const limiter = rateLimit({
//   windowMs: 15 * 60 * 1000, // 15 minutes
//   max: 100,
//   message: { error: "Too many requests. Please try again later." },
// });
// app.use("/api/", limiter);

// Log every incoming request (great for debugging)
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  next();
});

// ==================== MONGO CONNECTION ====================
const MONGODB_URI =
  "mongodb+srv://voting_and_club_db:tmf9lCooeh1Seg3A@cluster0.k8l5r3w.mongodb.net/ssg_election?retryWrites=true&w=majority&appName=Cluster0";

mongoose
  .connect(MONGODB_URI, { serverSelectionTimeoutMS: 5000 })
  .then(() => console.log("MongoDB Atlas connected successfully!"))
  .catch((err) => {
    console.error("MongoDB connection error:", err.message);
    console.log("Server continuing in safe mode...");
  });

// ==================== MODELS ====================

// === NEW: Permanent archive ng votes pagkatapos ng election ===
const historicalVoteSchema = new mongoose.Schema({
  voterId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Voter",
    required: true,
  },
  electionId: { type: String, required: true, index: true },
  fullName: { type: String, required: true },
  gradeSection: { type: String, required: true },
  lrn: { type: String, required: true },
  email: { type: String, required: true, lowercase: true },

  votedAt: { type: Date, required: true },
  archivedAt: { type: Date, default: Date.now },

  voteChoices: {
    type: Map,
    of: String,
    required: true,
  },

  // Optional: para mas madaling i-audit
  totalCandidatesVoted: { type: Number },
  electionTitle: String, // e.g. "December 2025 SSG Election"
});
const winnerSchema = new mongoose.Schema({
  electionId: { type: String, required: true, unique: true, index: true },
  electionTitle: { type: String, required: true },
  completedAt: { type: Date, default: Date.now },
  winners: [
    {
      position: { type: String, required: true },
      positionLabel: { type: String, required: true },
      winnerName: { type: String, required: true },
      winnerTeam: { type: String, required: true },
      candidateId: { type: String, required: true },
      votes: { type: Number, required: true },
      percentage: { type: String, required: true },
      isTie: { type: Boolean, default: false },
    },
  ],
  totalVotes: { type: Number, required: true },
});

historicalVoteSchema.index({ electionId: 1, lrn: 1 }, { unique: true }); // Prevent duplicates per election

const voterSchema = new mongoose.Schema(
  {
    email: { type: String, required: true, lowercase: true },
    lrn: { type: String, required: true },
    fullName: { type: String, required: true },
    gradeSection: { type: String, required: true },
    hasVoted: { type: Boolean, default: false },
    votedAt: Date,
    voteChoices: {
      type: Map,
      of: String,
      default: () => new Map(),
    },
    electionId: String, // null = pre-registration, set on vote
  },
  { timestamps: true }
);

// Unique constraint: same email/LRn can exist in different elections
voterSchema.index({ lrn: 1, electionId: 1 }, { unique: true, sparse: true });
voterSchema.index({ email: 1, electionId: 1 }, { unique: true, sparse: true });

const individualVoteSchema = new mongoose.Schema({
  voterId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Voter",
    required: true,
  },
  electionId: { type: String, required: true },
  votedAt: { type: Date, default: Date.now },
  voteChoices: { type: Map, of: String, required: true },
  lrn: String,
  fullName: String,
  gradeSection: String,
});

const voteSchema = new mongoose.Schema({
  electionId: { type: String, required: true },
  position: { type: String, required: true },
  candidateId: { type: String, required: true },
  count: { type: Number, default: 0 },
});

voteSchema.index(
  { electionId: 1, position: 1, candidateId: 1 },
  { unique: true }
);

const candidateSchema = new mongoose.Schema({
  electionId: { type: String, required: true },
  position: { type: String, required: true },
  candidateId: { type: String, required: true },
  name: { type: String, required: true },
  team: { type: String, required: true },
  party: String,
});

candidateSchema.index({ electionId: 1, candidateId: 1 }, { unique: true });

const electionSettingsSchema = new mongoose.Schema({
  currentElectionId: String,
  votingStart: Date,
  votingEnd: Date,
  isVotingActive: { type: Boolean, default: false },
});

const electionResultSchema = new mongoose.Schema({
  electionId: { type: String, required: true, unique: true },
  startDate: { type: Date, required: true },
  endDate: { type: Date, required: true },
  completedAt: { type: Date, default: Date.now },
  results: [
    {
      position: String,
      positionLabel: String,
      winnerName: String,
      winnerTeam: String,
      votes: Number,
      percentage: Number,
    },
  ],
  totalVotes: Number,
});
//table
const ElectionResult = mongoose.model("ElectionResult", electionResultSchema);
const Candidate = mongoose.model("Candidate", candidateSchema);
const HistoricalVote = mongoose.model("HistoricalVote", historicalVoteSchema);
const Vote = mongoose.model("Vote", voteSchema);
const IndividualVote = mongoose.model("IndividualVote", individualVoteSchema);
const Voter = mongoose.model("Voter", voterSchema);
const Winner = mongoose.model("Winner", winnerSchema);
const ElectionSettings = mongoose.model(
  "ElectionSettings",
  electionSettingsSchema
);
// ==================== NODEMAILER ====================
const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: "hugobayani@gmail.com",
    pass: "maqryoxbwzzpfdcv",
  },
  tls: { rejectUnauthorized: false },
});

const verificationCodes = new Map();

// ==================== HELPER ====================
function generateElectionId(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  return `election-${year}-${month}`;
}

function getPositionLabel(pos) {
  const map = {
    president: "President",
    vicePresident: "Vice President",
    secretary: "Secretary",
    treasurer: "Treasurer",
    auditor: "Auditor",
    pio: "P.I.O.",
    peaceOfficer: "Peace Officer",
  };
  return map[pos] || pos;
}

// ==================== ROUTES ====================

// Send verification code
app.post("/api/send-verification", async (req, res) => {
  const { email } = req.body;
  if (!email || !email.toLowerCase().endsWith("@gmail.com")) {
    return res.status(400).json({ error: "Only Gmail addresses are allowed" });
  }

  try {
    const normalized = email.toLowerCase();
    const voter = await Voter.findOne({ email: normalized });
    if (voter?.hasVoted) {
      return res.status(403).json({ error: "You have already voted" });
    }

    const code = Math.floor(100000 + Math.random() * 900000).toString();
    verificationCodes.set(normalized, {
      code,
      expires: Date.now() + 10 * 60 * 1000,
    });

    await transporter.sendMail({
      from: '"JOLNHS SSG Election" <hugobayani@gmail.com>',
      to: normalized,
      subject: "SSG Election Verification Code",
      html: `
        <h2>JOLNHS SSG Election</h2>
        <h1 style="letter-spacing:12px; font-size:3rem;">${code}</h1>
        <p>Valid for 10 minutes. Do not share.</p>
      `,
    });

    res.json({ message: "Verification code sent!" });
  } catch (err) {
    console.error("Send verification error:", err);
    res.status(500).json({ error: "Failed to send code" });
  }
});

// Verify code & register voter (FIXED - allows reuse across elections)
app.post("/api/verify-code", async (req, res) => {
  const { email, code, fullName, gradeSection, lrn } = req.body;

  if (!email || !code || !fullName || !gradeSection || !lrn) {
    return res.status(400).json({
      error: "All fields required: email, code, fullName, gradeSection, lrn",
    });
  }

  const normalized = email.toLowerCase();
  const stored = verificationCodes.get(normalized);

  if (!stored || Date.now() > stored.expires || stored.code !== code) {
    return res.status(400).json({ error: "Invalid or expired code" });
  }

  try {
    // Find existing voter (any election)
    let voter = await Voter.findOne({ email: normalized });

    // If voter exists but already voted in CURRENT election, block
    const settings = await ElectionSettings.findOne({});
    const currentElectionId = settings?.currentElectionId;

    if (voter?.hasVoted && voter.electionId === currentElectionId) {
      return res
        .status(403)
        .json({ error: "You have already voted in this election" });
    }

    if (!voter) {
      voter = new Voter({
        email: normalized,
        lrn,
        fullName,
        gradeSection,
      });
    } else {
      // Update info for new election
      voter.fullName = fullName;
      voter.gradeSection = gradeSection;
      voter.lrn = lrn;
      voter.hasVoted = false;
      voter.votedAt = null;
      voter.voteChoices = new Map();
      voter.electionId = null; // reset for new election
    }

    await voter.save();
    verificationCodes.delete(normalized);

    res.json({
      message: "Verified successfully",
      voterId: voter._id.toString(),
    });
  } catch (err) {
    console.error("VERIFY ERROR:", err.message);
    res.status(500).json({ error: "Server error during verification" });
  }
});

// Submit vote (single route - no duplicate)
app.post("/api/submit-vote", async (req, res) => {
  const {
    email,
    lrn,
    president,
    vicePresident,
    secretary,
    treasurer,
    auditor,
    pio,
    peaceOfficer,
  } = req.body;

  try {
    const voter = await Voter.findOne({ email: email.toLowerCase(), lrn });
    if (!voter || voter.hasVoted) {
      return res.status(403).json({ error: "Invalid or already voted" });
    }

    const settings = await ElectionSettings.findOne({});
    if (!settings?.isVotingActive || !settings.currentElectionId) {
      return res.status(403).json({ error: "Voting is closed" });
    }

    const electionId = settings.currentElectionId;

    // Update voter
    voter.voteChoices = new Map([
      ["president", president],
      ["vicePresident", vicePresident],
      ["secretary", secretary],
      ["treasurer", treasurer],
      ["auditor", auditor],
      ["pio", pio],
      ["peaceOfficer", peaceOfficer],
    ]);
    voter.hasVoted = true;
    voter.votedAt = new Date();
    voter.electionId = electionId;
    await voter.save();

    // Save permanent individual vote record
    await new IndividualVote({
      voterId: voter._id,
      electionId,
      votedAt: new Date(),
      voteChoices: voter.voteChoices,
      lrn: voter.lrn,
      fullName: voter.fullName,
      gradeSection: voter.gradeSection,
    }).save();

    // Update aggregate counts
    const votes = [
      { pos: "president", cand: president },
      { pos: "vicePresident", cand: vicePresident },
      { pos: "secretary", cand: secretary },
      { pos: "treasurer", cand: treasurer },
      { pos: "auditor", cand: auditor },
      { pos: "pio", cand: pio },
      { pos: "peaceOfficer", cand: peaceOfficer },
    ];

    for (const { pos, cand } of votes) {
      if (cand) {
        await Vote.findOneAndUpdate(
          { electionId, position: pos, candidateId: cand },
          { $inc: { count: 1 } },
          { upsert: true }
        );
      }
    }

    res.json({ message: "Vote recorded successfully!" });
  } catch (err) {
    console.error("Submit vote error:", err);
    res.status(500).json({ error: "Failed to record vote" });
  }
});
// Get candidates (now returns team too)
app.get("/api/admin/candidates", async (req, res) => {
  try {
    const settings = await ElectionSettings.findOne({});
    const electionId = settings?.currentElectionId || "temp-pre-election";
    const candidates = await Candidate.find({ electionId }).sort({
      position: 1,
    });
    res.json(candidates);
  } catch (err) {
    res.status(500).json({ error: "Failed to load candidates" });
  }
});

// Add candidate (NOW REQUIRES TEAM)
app.post("/api/admin/candidate", async (req, res) => {
  const { position, candidateId, name, team, party } = req.body;

  if (!position || !candidateId || !name || !team) {
    return res
      .status(400)
      .json({ error: "Position, Candidate ID, Name, and Team are required" });
  }

  try {
    const settings = await ElectionSettings.findOne({});
    if (settings?.isVotingActive) {
      return res
        .status(403)
        .json({ error: "Cannot add candidates while voting is active" });
    }

    const electionId = settings?.currentElectionId || "temp-pre-election";

    const candidate = await Candidate.findOneAndUpdate(
      { electionId, candidateId },
      {
        electionId,
        position,
        candidateId,
        name,
        team, // <--- NADAGDAG NA ITO
        party: party || "",
      },
      { upsert: true, new: true }
    );

    res.json({ message: "Candidate added successfully", candidate });
  } catch (err) {
    console.error("Add candidate error:", err);
    res.status(500).json({ error: "Failed to add candidate" });
  }
});

// Delete candidate
app.delete("/api/admin/candidate/:id", async (req, res) => {
  try {
    const settings = await ElectionSettings.findOne({});
    if (settings?.isVotingActive) {
      return res
        .status(403)
        .json({ error: "Cannot delete while voting is active" });
    }

    const deleted = await Candidate.findOneAndDelete({
      candidateId: req.params.id,
    });
    if (deleted) {
      await Vote.deleteMany({
        electionId: deleted.electionId,
        candidateId: req.params.id,
      });
    }

    res.json({
      message: deleted ? "Candidate deleted" : "Candidate not found",
    });
  } catch (err) {
    res.status(500).json({ error: "Failed to delete candidate" });
  }
});

// FIXED: Election periods endpoint (no crash even if no data)
app.get("/api/admin/election-periods", async (req, res) => {
  try {
    // Get from votes (current + past)
    let elections = await Vote.distinct("electionId");
    // Also get from archived results (even more reliable)
    const archived = await ElectionResult.distinct("electionId");
    elections = [...new Set([...elections, ...archived])];

    const safeElections = elections.filter(
      (id) => id && typeof id === "string" && id.startsWith("election-")
    );

    const periods = safeElections
      .map((id) => {
        const [year, month] = id.replace("election-", "").split("-");
        const date = new Date(parseInt(year), parseInt(month) - 1, 1);
        return {
          id,
          label:
            date.toLocaleDateString("en-PH", {
              year: "numeric",
              month: "long",
            }) + " Election",
          date: date.toLocaleDateString("en-PH", {
            year: "numeric",
            month: "long",
            day: "numeric",
          }),
        };
      })
      .sort((a, b) => b.id.localeCompare(a.id));

    res.json({ periods });
  } catch (err) {
    console.error("Election periods error:", err);
    res.json({ periods: [] });
  }
});
// Admin: Current election results tally
app.get("/api/admin/results", async (req, res) => {
  try {
    const settings = await ElectionSettings.findOne({});
    if (!settings?.currentElectionId) return res.json([]);

    const results = await Vote.find({
      electionId: settings.currentElectionId,
    }).sort({ position: 1, count: -1 });
    console.log(results);
    const candidates = await Candidate.find({
      electionId: settings.currentElectionId,
    });
    const candidateMap = {};
    candidates.forEach((c) => (candidateMap[c.candidateId] = c.name));

    const formatted = results.map((r) => ({
      position: r.position,
      candidateId: r.candidate,
      candidateName: candidateMap[r.candidate] || r.candidate,
      voteCount: r.count,
    }));

    res.json(formatted);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch admin results" });
  }
});
app.get("/api/admin/elections", async (req, res) => {
  try {
    const elections = await Vote.distinct("electionId");
    res.json(elections.sort().reverse());
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch elections" });
  }
});
app.get("/api/admin/vote-details/:id", async (req, res) => {
  try {
    const voter = await Voter.findById(req.params.id).select(
      "voteChoices fullName"
    );
    if (!voter || !voter.voteChoices)
      return res.status(404).json({ error: "No vote found." });
    res.json({ studentName: voter.fullName, choices: voter.voteChoices });
  } catch (err) {
    res.status(500).json({ error: "Failed to load details." });
  }
});
app.get("/api/admin/election-status", async (req, res) => {
  try {
    let settings = await ElectionSettings.findOne({});
    if (!settings) {
      settings = await new ElectionSettings({ isVotingActive: false }).save();
    }
    res.json({
      currentElectionId: settings.currentElectionId || null,
      votingStart: settings.votingStart,
      votingEnd: settings.votingEnd,
      isVotingActive: settings.isVotingActive,
    });
  } catch (err) {
    console.error("Election status error:", err);
    res.status(500).json({ error: "Failed to fetch election status" });
  }
});
app.get("/api/admin/all-voted-students", async (req, res) => {
  try {
    const voted = await Voter.find({
      hasVoted: true,
      votedAt: { $exists: true },
    })
      .select("fullName gradeSection lrn votedAt electionId")
      .sort({ votedAt: -1 });

    const students = voted.map((v) => ({
      id: v._id.toString(),
      name: v.fullName,
      grade: v.gradeSection,
      lrn: v.lrn,
      time: v.votedAt
        ? new Date(v.votedAt).toLocaleString("en-PH", {
            year: "numeric",
            month: "short",
            day: "numeric",
            hour: "2-digit",
            minute: "2-digit",
          })
        : "Unknown time",
      electionId: v.electionId || "unknown",
    }));

    res.json({ students, total: students.length });
  } catch (err) {
    console.error("All voted students error:", err);
    res.status(500).json({ error: "Failed to load voting history" });
  }
});

// Stop voting + archive all votes + save results
app.post("/api/admin/stop-voting", async (req, res) => {
  try {
    const settings = await ElectionSettings.findOne({});
    if (!settings || !settings.isVotingActive) {
      return res.status(400).json({ error: "No active election to stop" });
    }

    const electionId = settings.currentElectionId;
    const electionTitle = `Election ${electionId.replace("election-", "")}`;

    // 1. Aggregate votes
    const voteRecords = await Vote.find({ electionId });
    const totalVotes = voteRecords.reduce((sum, v) => sum + v.count, 0);

    // 2. Candidate mapping
    const candidates = await Candidate.find({ electionId });
    const candidateMap = {};
    candidates.forEach((c) => {
      candidateMap[c.candidateId] = { name: c.name, team: c.team };
    });

    // 3. Calculate winners
    const grouped = voteRecords.reduce((acc, r) => {
      if (!acc[r.position]) acc[r.position] = [];
      acc[r.position].push({ candidateId: r.candidateId, count: r.count });
      return acc;
    }, {});

    const winnersList = [];

    for (const [position, votes] of Object.entries(grouped)) {
      const sorted = votes.sort((a, b) => b.count - a.count);
      const max = sorted[0]?.count || 0;
      const topVoters = sorted.filter((v) => v.count === max);

      topVoters.forEach((w) => {
        const cand = candidateMap[w.candidateId] || {
          name: w.candidateId,
          team: "Unknown",
        };
        winnersList.push({
          position,
          positionLabel: getPositionLabel(position),
          winnerName: cand.name,
          winnerTeam: cand.team,
          candidateId: w.candidateId,
          votes: w.count,
          percentage:
            totalVotes > 0 ? ((w.count / totalVotes) * 100).toFixed(1) : "0.0",
          isTie: topVoters.length > 1,
        });
      });
    }

    // 4. Save to NEW Winner collection (permanent)
    await Winner.findOneAndUpdate(
      { electionId },
      {
        electionId,
        electionTitle,
        completedAt: new Date(),
        winners: winnersList,
        totalVotes,
      },
      { upsert: true }
    );

    // 5. Optional: Keep old ElectionResult if you still want it
    await ElectionResult.findOneAndUpdate(
      { electionId },
      {
        electionId,
        startDate: settings.votingStart,
        endDate: settings.votingEnd,
        completedAt: new Date(),
        results: winnersList,
        totalVotes,
      },
      { upsert: true }
    );

    // 6. Archive voter votes (from previous instructions)
    const votersWhoVoted = await Voter.find({ electionId, hasVoted: true });
    const archived = votersWhoVoted.map((v) => ({
      voterId: v._id,
      electionId,
      fullName: v.fullName,
      gradeSection: v.gradeSection,
      lrn: v.lrn,
      email: v.email,
      votedAt: v.votedAt,
      archivedAt: new Date(),
      voteChoices: v.voteChoices,
      totalCandidatesVoted: v.voteChoices.size,
      electionTitle,
    }));

    if (archived.length > 0) {
      try {
        const result = await HistoricalVote.insertMany(archived, {
          ordered: false, // ituloy kahit may error
          rawResult: true, // para makita kung ilan ang na-success
        });

        console.log(
          `Successfully archived ${result.insertedCount} new voter records`
        );
        if (result.insertedCount < archived.length) {
          console.log(
            `Skipped ${
              archived.length - result.insertedCount
            } duplicate records`
          );
        }
      } catch (bulkErr) {
        if (bulkErr.code === 11000) {
          // Normal lang 'to kapag may duplicates
          console.log(
            "Some records already exist in historicalvotes (duplicates skipped)"
          );
        } else {
          console.error("Bulk archive error:", bulkErr);
          // Pwede mo pa ring ituloy ang process kahit may error
        }
      }
    }

    // 7. Stop voting
    await ElectionSettings.updateOne({}, { isVotingActive: false });

    res.json({
      message: "Voting ended! Winners archived & voter records saved.",
      electionId,
      totalVoters: votersWhoVoted.length,
    });
  } catch (err) {
    console.error("STOP VOTING ERROR:", err);
    res.status(500).json({ error: "Failed to end election" });
  }
});

// Retrieve all votes for a specific past election
app.get("/api/admin/historical-votes/:electionId", async (req, res) => {
  try {
    const votes = await HistoricalVote.find({
      electionId: req.params.electionId,
    })
      .sort({ votedAt: -1 })
      .select("-__v -voteChoices._id"); // exclude unnecessary fields

    if (votes.length === 0) {
      return res
        .status(404)
        .json({ error: "No archived votes found for this election" });
    }

    res.json({
      electionId: req.params.electionId,
      totalVotes: votes.length,
      votes,
    });
  } catch (err) {
    console.error("Historical votes error:", err);
    res.status(500).json({ error: "Failed to retrieve historical votes" });
  }
});
app.get("/api/admin/past-results/:electionId", async (req, res) => {
  try {
    const result = await ElectionResult.findOne({
      electionId: req.params.electionId,
    });
    if (!result) {
      return res
        .status(404)
        .json({ error: "No results found for this election" });
    }
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch past results" });
  }
});
app.post("/api/admin/set-voting-period", async (req, res) => {
  const { start, end } = req.body;

  if (!start || !end) {
    return res.status(400).json({ error: "Start and end dates are required" });
  }

  try {
    const startDate = new Date(start);
    const endDate = new Date(end);

    if (isNaN(startDate) || isNaN(endDate)) {
      return res.status(400).json({ error: "Invalid date format" });
    }

    if (endDate <= startDate) {
      return res
        .status(400)
        .json({ error: "End date must be after start date" });
    }

    const electionId = generateElectionId(startDate);

    // Reset voters for this new election only
    await Voter.updateMany(
      { electionId },
      {
        $set: {
          hasVoted: false,
          votedAt: null,
          voteChoices: new Map(),
        },
      }
    );

    // Move candidates from temp to new election
    await Candidate.updateMany(
      { electionId: "temp-pre-election" },
      { $set: { electionId } }
    );

    // Reset vote counts
    await Vote.deleteMany({ electionId });

    // Update settings
    await ElectionSettings.findOneAndUpdate(
      {},
      {
        currentElectionId: electionId,
        votingStart: startDate,
        votingEnd: endDate,
        isVotingActive: true,
      },
      { upsert: true }
    );

    res.json({
      message: `New election started: ${electionId}`,
      electionId,
    });
  } catch (err) {
    console.error("Set voting period error:", err);
    res.status(500).json({ error: "Failed to start election" });
  }
});
app.get("/api/admin/wwinnerResult/:electedId", async (req, res) => {
  const currentOfficer = await Winner.findOne({
    elecltionId: req.params.electionId,
  })
    .sort({ votedAt: -1 })
    .select("-__v -voteChoices._id"); // exclude unnecessary fields

  res.status(200).json({ msg: currentOfficer });
}); // =============================================
//  NEW: Get current election winners (para sa "current" option)
// =============================================
app.get("/api/admin/winners", async (req, res) => {
  try {
    const settings = await ElectionSettings.findOne({});
    if (!settings?.currentElectionId) {
      return res.json({ winners: [], totalVotes: 0 });
    }

    const winnerDoc = await Winner.findOne({
      electionId: settings.currentElectionId,
    });

    if (!winnerDoc) {
      // Kung wala pa (ongoing pa ang election), balik ng empty
      return res.json({
        winners: [],
        totalVotes: 0,
        message: "Election ongoing or no results yet",
      });
    }

    res.json({
      winners: winnerDoc.winners,
      totalVotes: winnerDoc.totalVotes,
      electionId: winnerDoc.electionId,
      electionTitle: winnerDoc.electionTitle,
    });
  } catch (err) {
    console.error("Error fetching current winners:", err);
    res.status(500).json({ error: "Failed to load current results" });
  }
});

app.get("/api/admin/winners/:electionId", async (req, res) => {
  try {
    const winnerDoc = await Winner.findOne({
      electionId: req.params.electionId,
    });

    if (!winnerDoc) {
      return res.status(404).json({
        error: "No results found for this election",
      });
    }

    res.json({
      winners: winnerDoc.winners,
      totalVotes: winnerDoc.totalVotes,
      electionId: winnerDoc.electionId,
      electionTitle: winnerDoc.electionTitle,
      completedAt: winnerDoc.completedAt,
    });
  } catch (err) {
    console.error("Error fetching past winners:", err);
    res.status(500).json({ error: "Failed to load election results" });
  }
});

// 1. Dashboard Voting Stats (real-time tally)
app.get("/api/admin/dashboard-voting-stats", async (req, res) => {
  try {
    const settings = await ElectionSettings.findOne({});
    if (!settings?.currentElectionId) {
      return res.json({
        totalVoters: 0,
        totalVotesCast: 0,
        turnoutPercentage: "0.0",
        byPosition: {
          President: [],
          VicePresident: [],
          Secretary: [],
          Treasurer: [],
          Auditor: [],
          PIO: [],
          PeaceOfficer: [],
        },
      });
    }

    const electionId = settings.currentElectionId;

    // Total voters (lahat ng registered voters sa current election)
    const totalVoters = await Voter.countDocuments({ electionId });

    // Total votes cast
    const totalVotesCast = await Voter.countDocuments({
      electionId,
      hasVoted: true,
    });

    const turnout =
      totalVoters > 0
        ? ((totalVotesCast / totalVoters) * 100).toFixed(1)
        : "0.0";

    // Per position tally (top candidates lang, pwede mong i-limit)
    const byPosition = {
      President: [],
      VicePresident: [],
      Secretary: [],
      Treasurer: [],
      Auditor: [],
      PIO: [],
      PeaceOfficer: [],
    };

    const votes = await Vote.find({ electionId }).sort({ count: -1 });

    votes.forEach((v) => {
      if (byPosition[v.position]) {
        byPosition[v.position].push({
          name: v.candidateId, // Pwede mo palitan ng real name via Candidate lookup
          votes: v.count,
        });
      }
    });

    res.json({
      totalVoters,
      totalVotesCast,
      turnoutPercentage: turnout,
      byPosition,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to load dashboard stats" });
  }
});

// 2. Dashboard Registration Stats (kung may club registration pa rin)
app.get("/api/admin/dashboard-registration-stats", async (req, res) => {
  try {
    // Halimbawa lang — pwede mong i-adjust base sa schema mo
    const total = await Voter.countDocuments(); // o kung may club field
    const byClub = {
      Sports: 48,
      Torch: 32,
      // ... etc.
    };

    res.json({
      totalRegistrations: total,
      byClub,
    });
  } catch (err) {
    res.status(500).json({ error: "Failed to load registration stats" });
  }
});
// Server
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`SSG Voting Backend running on http://localhost:${PORT}`);
  console.log(`Ready for election!`);
});
