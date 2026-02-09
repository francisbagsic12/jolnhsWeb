const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const nodemailer = require("nodemailer");

const app = express();

// ==================== MIDDLEWARE ====================
app.use(
  cors({
    origin: [
      "http://localhost:3000",
      "http://localhost:5173",
      "https://jolnhs-admin-control.netlify.app",
      "https://jolnhswebpage.netlify.app",
    ],
    credentials: true,
  }),
);
app.use(express.json());

// const limiter = rateLimit({
//   windowMs: 15 * 60 * 1000, // 15 minutes
//   max: 100,
//   message: { error: "Too many requests. Please try again later." },
// });
// app.use("/api/", limiter);

const clubVerificationLimiter = rateLimit({
  windowMs: 10 * 60 * 1000, // 10 minutes
  max: 5, // limit each IP to 5 requests per window
  message: {
    error: "Too many verification attempts. Try again after 10 minutes.",
  },
  keyGenerator: (req) => req.ip,
});
const clubVerificationCodes = new Map();
// Log every incoming request (great for debugging)
app.use((req, res, next) => {
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

// NEW: Permanent archive ng votes pagkatapos ng election ===
// Announcement Schema
const announcementSchema = new mongoose.Schema(
  {
    text: {
      type: String,
      required: true,
      trim: true,
    },
    active: {
      type: Boolean,
      default: true,
    },
  },
  {
    timestamps: true,
  },
);

const Announcement = mongoose.model("Announcement", announcementSchema);
const clubRegistrationSchema = new mongoose.Schema({
  email: { type: String, required: true, lowercase: true },
  lrn: { type: String, required: true },
  fullName: { type: String, required: true },
  gradeSection: { type: String, required: true },
  contactNumber: { type: String, required: true },
  club: { type: String, required: true },
  status: {
    type: String,
    enum: ["pending", "approved", "rejected"],
    default: "pending",
  },
  appliedAt: { type: Date, default: Date.now },
});
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

  totalCandidatesVoted: { type: Number },
  electionTitle: String, // e.g. "December 2025 SSG Election"
});
const winnerSchema = new mongoose.Schema({
  electionId: { type: String, required: true, unique: true, index: true },
  electionTitle: { type: String, required: true },
  votingStart: { type: Date },
  completedAt: { type: Date, default: Date.now },
  isShown: { type: Boolean, default: false }, // Track if winners are currently displayed
  shownAt: { type: Date }, // When winners were last shown
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
  { timestamps: true },
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
  { unique: true },
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
const Clubs = mongoose.model("Clubs", clubRegistrationSchema);
const ElectionSettings = mongoose.model(
  "ElectionSettings",
  electionSettingsSchema,
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
  const day = String(date.getDate()); // ← FIXED: getDate() for day of month (1-31), not getDay() (0-6 weekday)
  console.log(day);
  return `election-${year}-${month}-${day}`;
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
    // Only block if the voter has already voted in the CURRENT election
    const settings = await ElectionSettings.findOne({});
    const currentElectionId = settings?.currentElectionId;
    const voter = await Voter.findOne({ email: normalized });
    if (voter?.hasVoted && voter.electionId === currentElectionId) {
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
    const settings = await ElectionSettings.findOne({});
    if (!settings?.isVotingActive || !settings.currentElectionId) {
      return res.status(403).json({ error: "Voting is closed" });
    }

    const electionId = settings.currentElectionId;

    const voter = await Voter.findOne({ email: email.toLowerCase(), lrn });
    // Only block if the voter has already voted in the CURRENT election
    if (!voter || (voter.hasVoted && voter.electionId === electionId)) {
      return res.status(403).json({ error: "Invalid or already voted" });
    }

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
          { upsert: true },
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
    console.log(candidates, electionId);

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
      { upsert: true, new: true },
    );

    res.json({ message: "Candidate added successfully", candidate });
  } catch (err) {
    console.error("Add candidate error:", err);
    res.status(500).json({ error: "Failed to add candidate" });
  }
});
app.delete(
  "/api/admin/deleteAllCandidatesONTime/:electionIdss",
  async (req, res) => {
    try {
      const { electionIdss } = req.params;
      const electionId = "election-" + electionIdss.substring(0, 10);
      console.log("deleted ID:", electionId);
      if (!electionId) {
        return res.status(400).json({ error: "Election ID is required" });
      }

      const deleted = await Candidate.deleteMany({ electionId });
      await Vote.deleteMany({ electionId });

      res.json({
        message: `Deleted ${deleted.deletedCount} candidates and their votes`,
      });
    } catch (err) {
      console.error("Delete all candidates error:", err);
      res
        .status(500)
        .json({ error: "Failed to delete all candidates: " + err.message });
    }
  },
);
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
    let elections = await Vote.distinct("electionId");
    const archived = await Winner.distinct("electionId");
    elections = [...new Set([...elections, ...archived])];

    const safeElections = elections.filter(
      (id) => id && typeof id === "string" && id.startsWith("election-"),
    );

    const periods = await Promise.all(
      safeElections.map(async (id) => {
        const winner = await Winner.findOne({ electionId: id });

        let displayDate = "Date not set";
        let startDateISO = null;

        if (winner?.votingStart) {
          const start = new Date(winner.votingStart);
          displayDate = start.toLocaleDateString("en-PH", {
            month: "long",
            day: "numeric",
            year: "numeric",
          });
          startDateISO = start.toISOString().split("T")[0];
        } else {
          // Fallback kapag wala pang votingStart (old elections)
          const [year, month] = id.replace("election-", "").split("-");
          const dateObj = new Date(parseInt(year), parseInt(month) - 1, 1);
          displayDate = dateObj.toLocaleDateString("en-PH", {
            month: "long",
            year: "numeric",
          });
        }

        return {
          id,
          label: `${displayDate} Election`,
          date: displayDate,
          startDate: startDateISO, // para ma-filter o ma-sort kung gusto mo sa frontend
        };
      }),
    );

    // Sort newest first
    periods.sort((a, b) => b.id.localeCompare(a.id));

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
      candidateId: r.candidateId, // FIXED: r.candidate -> r.candidateId (assuming typo in code)
      candidateName: candidateMap[r.candidateId] || r.candidateId,
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
      "voteChoices fullName",
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

    // // 2. Candidate mapping
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
      { upsert: true },
    );

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
      { upsert: true },
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
          `Successfully archived ${result.insertedCount} new voter records`,
        );
        if (result.insertedCount < archived.length) {
          console.log(
            `Skipped ${
              archived.length - result.insertedCount
            } duplicate records`,
          );
        }
      } catch (bulkErr) {
        if (bulkErr.code === 11000) {
          // Normal lang 'to kapag may duplicates
          console.log(
            "Some records already exist in historicalvotes (duplicates skipped)",
          );
        } else {
          console.error("Bulk archive error:", bulkErr);
          // Pwede mo pa ring ituloy ang process kahit may error
        }
      }
    }

    // 7. Stop voting
    await ElectionSettings.updateOne(
      {},
      { isVotingActive: false, currentElectionId: "" },
    );

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
app.post("/api/admin/set-voting-period/:electionIdState", async (req, res) => {
  const { start, end } = req.body;
  const { electionIdState } = req.params;
  const electionId = "election-" + electionIdState.substring(0, 10);
  console.log("Starting new election with ID:", electionId);
  if (!start || !end) {
    return res.status(400).json({ error: "Start and end dates are required" });
  }

  try {
    const startDate = new Date(start);
    const endDate = new Date(end);

    if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
      return res.status(400).json({ error: "Invalid date format" });
    }

    if (endDate <= startDate) {
      return res
        .status(400)
        .json({ error: "End date must be after start date" });
    }

    // const electionId = generateElectionId(startDate);

    // Siguraduhing walang existing active election na pareho ang ID
    const existing = await Winner.findOne({ electionId });
    if (existing) {
      return res.status(400).json({
        error: `Election ${electionId} already exists. Cannot create duplicate.`,
      });
    }

    // Reset voters for this new election only
    await Voter.updateMany(
      { electionId },
      {
        $set: {
          hasVoted: false,
          votedAt: null,
          voteChoices: new Map(),
          electionId: electionId,
        },
      },
    );

    // Move candidates from temp to this new election
    const movedCount = await Candidate.updateMany(
      { electionId: "temp-pre-election" },
      { $set: { electionId } },
    );
    console.log(
      `Moved ${movedCount.modifiedCount} candidates to ${electionId}`,
    );

    // Reset vote counts for this election
    await Vote.deleteMany({ electionId });

    // Update election settings (current active election)
    await ElectionSettings.findOneAndUpdate(
      {},
      {
        currentElectionId: electionId,
        votingStart: startDate,
        votingEnd: endDate,
        isVotingActive: true,
      },
      { upsert: true, new: true },
    );

    // **BAGONG RECORD** sa Winner collection — hindi update, bagong entry
    const newWinnerRecord = new Winner({
      electionId,
      electionTitle: `SSG Election ${electionId.replace("election-", "")}`,
      votingStart: startDate, // eksaktong start date
      completedAt: null, // ise-set pag end voting
      winners: [], // wala pa
      totalVotes: 0,
    });

    await newWinnerRecord.save();

    console.log(
      `Created new Winner record for ${electionId} with votingStart: ${startDate}`,
    );

    res.json({
      message: `New election started successfully`,
      electionId,
      votingStart: startDate.toISOString(),
      votingEnd: endDate.toISOString(),
    });
  } catch (err) {
    console.error("Set voting period error:", err);
    res.status(500).json({
      error: "Failed to start election",
      details: err.message,
    });
  }
});
app.get("/api/admin/wwinnerResult/:electedId", async (req, res) => {
  const currentOfficer = await Winner.findOne({
    electionId: req.params.electedId, // FIXED: elecltionId -> electionId, and param is electedId
  })
    .sort({ completedAt: -1 }) // FIXED: votedAt -> completedAt (based on schema)
    .select("-__v"); // exclude __v

  if (!currentOfficer) {
    return res.status(404).json({ error: "No winner found" });
  }

  res.status(200).json(currentOfficer); // FIXED: { msg: currentOfficer } -> currentOfficer
}); // =============================================
//  NEW: Get current election winners (para sa "current" option)
// =============================================
app.get("/api/admin/winners", async (req, res) => {
  try {
    // const settings = await ElectionSettings.findOne({});
    // if (!settings?.currentElectionId) {
    //   return res.json({
    //     winners: [],
    //     totalVotes: 0,
    //     isShown: false,
    //     electionId: null,
    //     electionTitle: null,
    //     completedAt: null,
    //     shownAt: null,
    //   });
    // }

    const winnerDoc = await Winner.findOne({
      isShown: true,
    });
    console.log(winnerDoc);
    if (!winnerDoc) {
      // Kung wala pa (ongoing pa ang election), balik ng empty with isShown: false
      return res.json({
        winners: [],
        totalVotes: 0,
        electionId: null,
        electionTitle: null,
        completedAt: null,
        isShown: false,
        shownAt: null,
        message: "Election ongoing or no results yet",
      });
    }

    res.json({
      winners: winnerDoc.winners,
      totalVotes: winnerDoc.totalVotes,
      electionId: winnerDoc.electionId,
      electionTitle: winnerDoc.electionTitle,
      completedAt: winnerDoc.completedAt,
      isShown: winnerDoc.isShown,
      shownAt: winnerDoc.shownAt,
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
      isShown: winnerDoc.isShown,
      shownAt: winnerDoc.shownAt,
    });
  } catch (err) {
    console.error("Error fetching past winners:", err);
    res.status(500).json({ error: "Failed to load election results" });
  }
});

// Toggle winners display status (only ONE election can be shown at a time)
app.put("/api/admin/winners/:electionId/toggle-show", async (req, res) => {
  try {
    const { electionId } = req.params;
    const winnerDoc = await Winner.findOne({ electionId });

    if (!winnerDoc) {
      return res.status(404).json({
        error: "No results found for this election",
      });
    }

    // If showing winners for this election, hide all others first
    if (!winnerDoc.isShown) {
      // Want to SHOW this election
      // Step 1: Hide all others
      await Winner.updateMany(
        { electionId: { $ne: electionId } },
        { $set: { isShown: false } },
      );
      console.log(`Hidden all other elections, now showing ${electionId}`);

      // Step 2: Show this one
      winnerDoc.isShown = true;
      winnerDoc.shownAt = new Date();
      await winnerDoc.save();

      res.json({
        success: true,
        isShown: true,
        electionId,
        message: `Winners from ${electionId} are now shown (all others hidden)`,
      });
    } else {
      // Want to HIDE this election
      winnerDoc.isShown = false;
      await winnerDoc.save();

      res.json({
        success: true,
        isShown: false,
        electionId,
        message: "Winners are now hidden",
      });
    }
  } catch (err) {
    console.error("Error toggling winners display:", err);
    res.status(500).json({ error: "Failed to toggle winners display" });
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
      if (byPosition[getPositionLabel(v.position)]) {
        // FIXED: use positionLabel
        byPosition[getPositionLabel(v.position)].push({
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

app.post(
  "/api/club/send-verification",
  clubVerificationLimiter,
  async (req, res) => {
    const { email } = req.body;

    if (!email || !email.toLowerCase().endsWith("@gmail.com")) {
      return res
        .status(400)
        .json({ error: "Only Gmail addresses are allowed" });
    }

    const normalizedEmail = email.toLowerCase();

    try {
      const existing = await Clubs.findOne({
        email: normalizedEmail,
      });
      if (existing && existing.status === "approved") {
        return res.status(403).json({
          error: "You are already an approved member of this club.",
        });
      }

      // Generate 6-digit code
      const code = Math.floor(100000 + Math.random() * 900000).toString();

      // Store with 10-min expiry
      clubVerificationCodes.set(normalizedEmail, {
        code,
        expires: Date.now() + 10 * 60 * 1000,
      });

      // Send email
      await transporter.sendMail({
        from: '"JOLNHS Club Registration" <hugobayani@gmail.com>',
        to: normalizedEmail,
        subject: "Club Registration Verification Code",
        html: `
          <h2>JOLNHS Club Registration</h2>
          <h1 style="letter-spacing:12px; font-size:3rem;">${code}</h1>
          <p>This code is valid for 10 minutes. Do not share it.</p>
          <p>If you didn't request this, ignore this email.</p>
        `,
      });

      console.log(`Club OTP sent to ${normalizedEmail}: ${code}`);

      res.json({ message: "Verification code sent! Check your email." });
    } catch (err) {
      console.error("Club send-verification error:", err);
      res.status(500).json({ error: "Failed to send verification code" });
    }
  },
);

// 2. Verify code for club registration
app.post("/api/club/verify-code", async (req, res) => {
  const { email, code } = req.body;

  if (!email || !code) {
    return res.status(400).json({ error: "Email and code are required" });
  }

  const normalizedEmail = email.toLowerCase();
  const stored = clubVerificationCodes.get(normalizedEmail);

  try {
    if (!stored || Date.now() > stored.expires || stored.code !== code) {
      return res.status(400).json({ error: "Invalid or expired code" });
    }

    // Success: remove the code so it can't be reused
    clubVerificationCodes.delete(normalizedEmail);

    res.json({
      message: "Email verified successfully",
      email: normalizedEmail,
    });
  } catch (err) {
    console.error("Club verify-code error:", err);
    res.status(500).json({ error: "Verification failed" });
  }
});

//registration club
app.post("/api/club/register", async (req, res) => {
  const { fullName, gradeSection, contactNumber, email, club, lrn } = req.body;

  // Updated validation – kasama na ang lrn
  if (!fullName || !gradeSection || !contactNumber || !email || !club || !lrn) {
    return res
      .status(400)
      .json({ error: "All fields are required (including LRN)" });
  }

  if (!email.toLowerCase().endsWith("@gmail.com")) {
    return res.status(400).json({ error: "Only Gmail addresses allowed" });
  }

  if (!/^\d{12}$/.test(lrn)) {
    return res.status(400).json({ error: "LRN must be exactly 12 digits" });
  }

  try {
    const normalizedEmail = email.toLowerCase();

    // Check if already registered for this club
    const existing = await Clubs.findOne({
      email: normalizedEmail,
      club,
    });
    if (existing) {
      return res
        .status(409)
        .json({ error: "You have already registered for this club" });
    }

    // Create registration – kasama na ang lrn
    const registration = new Clubs({
      fullName,
      gradeSection,
      contactNumber,
      email: normalizedEmail,
      club,
      lrn, // ← NADAGDAG NA ITO
    });

    await registration.save();

    // Send confirmation email
    await transporter.sendMail({
      from: '"JOLNHS Club Registration" <hugobayani@gmail.com>',
      to: email,
      subject: "Club Registration Received",
      html: `
        <h2>Hello ${fullName},</h2>
        <p>Your registration for <strong>${club}</strong> has been received!</p>
        <p>LRN: ${lrn}</p>
        <p>Status: <strong>Pending</strong></p>
        <p>We will notify you once approved by the club adviser.</p>
        <p>Thank you!</p>
      `,
    });

    res.status(201).json({
      message: "Registration submitted successfully! Check your email.",
      registrationId: registration._id.toString(),
    });
  } catch (err) {
    console.error("Club registration error:", err);
    if (err.name === "ValidationError") {
      return res.status(400).json({ error: err.message });
    }
    res.status(500).json({ error: "Failed to submit registration" });
  }
});

// 2. Get all club registrations (for admin)
app.get("/api/admin/club-registrations", async (req, res) => {
  try {
    const registrations = await Clubs.find()
      .sort({ appliedAt: -1 })
      .select("-__v");

    res.json(registrations);
  } catch (err) {
    console.error("Fetch club registrations error:", err);
    res.status(500).json({ error: "Failed to load registrations" });
  }
});

// 3. Admin: Approve or Reject registration
app.patch("/api/admin/club-registration/:id", async (req, res) => {
  const { status } = req.body; // "approved" or "rejected"

  if (!["approved", "rejected"].includes(status)) {
    return res
      .status(400)
      .json({ error: "Invalid status. Use 'approved' or 'rejected'" });
  }

  try {
    const registration = await Clubs.findByIdAndUpdate(
      req.params.id,
      { status },
      { new: true, runValidators: true },
    );

    if (!registration) {
      return res.status(404).json({ error: "Registration not found" });
    }

    // Notify student
    await transporter.sendMail({
      from: '"JOLNHS Club Registration" <hugobayani@gmail.com>',
      to: registration.email,
      subject: `Club Registration ${status.toUpperCase()}`,
      html: `
        <h2>Hello ${registration.fullName},</h2>
        <p>Your registration for <strong>${
          registration.club
        }</strong> has been <strong>${status}</strong>!</p>
        ${
          status === "approved"
            ? "<p><strong>Congratulations!</strong> You are now officially a member.</p>"
            : "<p>Sorry, your application was not approved this time.</p>"
        }
        <p>LRN: ${registration.lrn}</p>
        <p>Thank you for your interest!</p>
      `,
    });

    res.json({
      message: `Registration ${status} successfully`,
      registration,
    });
  } catch (err) {
    console.error("Update club registration error:", err);
    res.status(500).json({ error: "Failed to update status" });
  }
});

// app.get("/api/admin/dashboard-registration-stats", async (req, res) => {
//   try {
//     const totalRegistrations = await Clubs.countDocuments();

//     // Count per club (group by club field)
//     const byClub = await Clubs.aggregate([
//       {
//         $group: {
//           _id: "$club",
//           count: { $sum: 1 },
//         },
//       },
//       {
//         $project: {
//           club: "$_id",
//           count: 1,
//        _id: 0,
//      },
//    },
//  ]);

//     // Convert to object for easy frontend use
//     const byClubObj = byClub.reduce((acc, item) => {
//       acc[item.club] = item.count;
//       return acc;
//     }, {});

//     res.json({
//       totalRegistrations,
//       byClub: byClubObj,
//     });
//   } catch (err) {
//     console.error("Dashboard stats error:", err);
//     res.status(500).json({ error: "Failed to load registration stats" });
//   }
// });

app.get("/api/admin/dashboard-registration-stats", async (req, res) => {
  try {
    // Total registrations (all statuses)
    const totalRegistrations = await Clubs.countDocuments();

    // Breakdown per club with status counts
    const byClub = await Clubs.aggregate([
      {
        $group: {
          _id: "$club",
          total: { $sum: 1 },
          pending: {
            $sum: { $cond: [{ $eq: ["$status", "pending"] }, 1, 0] },
          },
          approved: {
            $sum: { $cond: [{ $eq: ["$status", "approved"] }, 1, 0] },
          },
          rejected: {
            $sum: { $cond: [{ $eq: ["$status", "rejected"] }, 1, 0] },
          },
        },
      },
      {
        $project: {
          club: "$_id",
          total: 1,
          pending: 1,
          approved: 1,
          rejected: 1,
          _id: 0,
        },
      },
      {
        $sort: { total: -1 }, // Highest total first
      },
    ]);

    // Convert to friendly object format for frontend
    const byClubObj = byClub.reduce((acc, item) => {
      acc[item.club] = {
        total: item.total,
        pending: item.pending,
        approved: item.approved,
        rejected: item.rejected,
      };
      return acc;
    }, {});

    // Also compute global totals
    const globalTotals = byClub.reduce(
      (acc, item) => ({
        total: acc.total + item.total,
        pending: acc.pending + item.pending,
        approved: acc.approved + item.approved,
        rejected: acc.rejected + item.rejected,
      }),
      { total: 0, pending: 0, approved: 0, rejected: 0 },
    );

    res.json({
      totalRegistrations,
      byClub: byClubObj,
      global: globalTotals,
      lastUpdated: new Date().toISOString(),
    });
  } catch (err) {
    console.error("Dashboard registration stats error:", err);
    res.status(500).json({ error: "Failed to load registration stats" });
  }
});

// POST /api/admin/announcement - Mag-post ng bagong announcement
app.post("/api/admin/announcement", async (req, res) => {
  const { text } = req.body;

  if (!text || typeof text !== "string" || text.trim().length === 0) {
    return res.status(400).json({ error: "Announcement text is required" });
  }

  try {
    // Gumawa ng bagong announcement (hindi update)
    const newAnnouncement = new Announcement({
      text: text.trim(),
      createdAt: new Date(),
      active: true,
      // createdBy: req.user?.id || "admin" // kung may auth
    });

    await newAnnouncement.save();

    // Optional: I-deactivate ang previous active announcements kung gusto mo lang 1 active
    // await Announcement.updateMany(
    //   { active: true, _id: { $ne: newAnnouncement._id } },
    //   { $set: { active: false } }
    // );

    res.json({
      message: "Announcement published successfully",
      announcement: newAnnouncement,
    });
  } catch (err) {
    console.error("Error publishing announcement:", err);
    res.status(500).json({ error: "Failed to save announcement" });
  }
});

app.get("/api/announcement", async (req, res) => {
  try {
    const latest = await Announcement.findOne({ active: true })
      .sort({ createdAt: -1 })
      .select("text createdAt");

    res.json({
      text: latest?.text || "",
      createdAt: latest?.createdAt || null,
    });
  } catch (err) {
    console.error("Error fetching announcement:", err);
    res.status(500).json({ text: "" });
  }
});
// Server
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`SSG Voting Backend running on http://localhost:${PORT}`);
  console.log(`Ready for election!`);
});
