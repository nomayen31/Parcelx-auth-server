import fs from "fs";
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { MongoClient, ServerApiVersion, ObjectId } from "mongodb";
import Stripe from "stripe";
import admin from "firebase-admin";
import verifyToken from "./verifyToken.js";

dotenv.config();

const serviceAccount = JSON.parse(
  await fs.promises.readFile(
    new URL("./firebase-admin-key.json", import.meta.url),
    "utf-8"
  )
);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const app = express();
const port = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());

if (!process.env.PAYMENT_GATEWAY_KEY) {
  console.warn("⚠️ PAYMENT_GATEWAY_KEY is not set in .env");
}
const stripe = new Stripe(process.env.PAYMENT_GATEWAY_KEY);

if (!process.env.DB_USER || !process.env.DB_PASS || !process.env.DB_NAME) {
  console.error("❌ DB_USER / DB_PASS / DB_NAME must be set in .env");
  process.exit(1);
}

const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.8k7klrr.mongodb.net/${process.env.DB_NAME}?retryWrites=true&w=majority&appName=Cluster0`;

const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

async function run() {
  try {
    await client.connect();
    console.log("✅ Connected to MongoDB");

    const db = client.db(process.env.DB_NAME);
    const usersCollection = db.collection("users");
    const parcelsCollection = db.collection("parcels");
    const paymentsCollection = db.collection("payments");
    const trackingCollection = db.collection("tracking");
    const ridersCollection = db.collection("riders");

    await usersCollection.createIndex({ email: 1 }, { unique: true });
    await paymentsCollection.createIndex({ createdAt: -1 });
    await paymentsCollection.createIndex({ payerEmail: 1, createdAt: -1 });
    await paymentsCollection.createIndex(
      { paymentIntentId: 1 },
      { unique: true }
    );
    await trackingCollection.createIndex({ tracking_id: 1, time: -1 });
    await trackingCollection.createIndex({ parcel_id: 1 });

    app.post("/users", async (req, res) => {
      try {
        const {
          uid = null,
          email,
          name = "",
          image = "",
          role,
          provider = "email",
        } = req.body;

        if (!email) {
          return res
            .status(400)
            .json({ success: false, message: "Email is required" });
        }

        const now = new Date();
        const setOnInsertDoc = {
          uid,
          email,
          name,
          image,
          provider,
          role: role || "user",
          createdAt: now,
        };

        const result = await usersCollection.updateOne(
          { email },
          { $setOnInsert: setOnInsertDoc, $set: { lastLogin: now } },
          { upsert: true }
        );

        if (result.upsertedCount === 1) {
          return res
            .status(201)
            .json({ success: true, message: "✅ User created" });
        }

        return res
          .status(200)
          .json({
            success: true,
            message: "ℹ️ User exists — lastLogin refreshed",
          });
      } catch (err) {
        if (err?.code === 11000) {
          return res
            .status(409)
            .json({ success: false, message: "User already exists" });
        }
        console.error("Error /users:", err);
        res
          .status(500)
          .json({ success: false, message: "Internal server error" });
      }
    });

    app.get("/users/search", async (req, res) => {
      try {
        const { query } = req.query;
        if (!query || query.trim() === "") {
          return res
            .status(400)
            .json({ success: false, message: "Search query required." });
        }

        const users = await usersCollection
          .find({
            $or: [
              { email: { $regex: query, $options: "i" } },
              { name: { $regex: query, $options: "i" } },
            ],
          })
          .project({ email: 1, name: 1, role: 1, createdAt: 1, uid: 1 })
          .limit(10)
          .toArray();

        res
          .status(200)
          .json({ success: true, total: users.length, data: users });
      } catch (error) {
        console.error("Error searching users:", error);
        res
          .status(500)
          .json({ success: false, message: "Failed to search users" });
      }
    });

    app.patch("/users/:id/role", verifyToken, async (req, res) => {
      try {
        const id = req.params.id;
        const { role } = req.body;
        if (!ObjectId.isValid(id)) {
          return res
            .status(400)
            .json({ success: false, message: "Invalid user ID." });
        }
        if (!role) {
          return res
            .status(400)
            .json({ success: false, message: "Role is required." });
        }

        const allowedRoles = ["user", "admin", "rider"];
        if (!allowedRoles.includes(role.toLowerCase())) {
          return res.status(400).json({
            success: false,
            message: `Invalid role. Allowed: ${allowedRoles.join(", ")}`,
          });
        }

        const result = await usersCollection.updateOne(
          { _id: new ObjectId(id) },
          { $set: { role: role.toLowerCase() } }
        );

        if (result.matchedCount === 0) {
          return res
            .status(404)
            .json({ success: false, message: "User not found." });
        }

        res
          .status(200)
          .json({ success: true, message: `User role updated to '${role}'.` });
      } catch (error) {
        console.error("❌ Error updating user role:", error);
        res.status(500).json({
          success: false,
          message: "Server error while updating user role.",
          error: error.message,
        });
      }
    });

    app.get("/users/role", async (req, res) => {
      try {
        const { email } = req.query;
        if (!email) {
          return res
            .status(400)
            .json({ success: false, message: "Email is required." });
        }

        const user = await usersCollection.findOne(
          { email },
          { projection: { name: 1, email: 1, role: 1, createdAt: 1, _id: 0 } }
        );

        if (!user) {
          return res
            .status(404)
            .json({ success: false, message: "User not found." });
        }

        res.status(200).json({
          success: true,
          role: user.role || "user",
          data: user,
          message: "User role fetched successfully.",
        });
      } catch (error) {
        console.error("Error fetching user role:", error);
        res.status(500).json({
          success: false,
          message: "Server error while fetching user role.",
          error: error.message,
        });
      }
    });

    app.get("/users", verifyToken, async (_req, res) => {
      try {
        const users = await usersCollection
          .find()
          .sort({ createdAt: -1 })
          .toArray();
        res
          .status(200)
          .json({ success: true, total: users.length, data: users });
      } catch (error) {
        console.error("Error fetching users:", error);
        res.status(500).json({ success: false, message: error.message });
      }
    });

    app.get("/parcels", verifyToken, async (req, res) => {
      try {
        const { email } = req.query;
        const query = email ? { createdByEmail: email } : {};
        const parcels = await parcelsCollection
          .find(query)
          .sort({ createdAt: -1 })
          .toArray();
        res
          .status(200)
          .json({ success: true, total: parcels.length, data: parcels });
      } catch (error) {
        console.error("Error fetching parcels:", error);
        res
          .status(500)
          .json({
            success: false,
            message: "Failed to fetch parcels",
            error: error.message,
          });
      }
    });

    app.get("/parcels/:id", async (req, res) => {
      try {
        const { id } = req.params;
        const parcel = await parcelsCollection.findOne({
          _id: new ObjectId(id),
        });
        if (!parcel) {
          return res
            .status(404)
            .json({ success: false, message: "Parcel not found" });
        }

        res
          .status(200)
          .json({
            success: true,
            message: "Parcel retrieved successfully",
            data: parcel,
          });
      } catch (error) {
        console.error("Error fetching parcel:", error);
        res
          .status(500)
          .json({
            success: false,
            message: "Server error while fetching parcel",
            error: error.message,
          });
      }
    });

    app.post("/parcels", verifyToken, async (req, res) => {
      try {
        const newParcel = {
          ...req.body,
          paymentStatus: req.body.paymentStatus || "Unpaid",
          createdAtReadable:
            req.body.createdAtReadable || new Date().toISOString(),
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        const result = await parcelsCollection.insertOne(newParcel);
        res
          .status(201)
          .json({
            success: true,
            message: "Parcel added successfully",
            data: result,
          });
      } catch (error) {
        console.error("Error inserting parcel:", error);
        res
          .status(500)
          .json({
            success: false,
            message: "Failed to add parcel",
            error: error.message,
          });
      }
    });

    app.post("/create-payment-intent", async (req, res) => {
      try {
        const { amountInCents, parcelId, payerEmail } = req.body;
        const amountMinor = Number(amountInCents);
        if (!Number.isInteger(amountMinor) || amountMinor <= 0) {
          return res.status(400).json({ error: "Invalid amountInCents" });
        }

        const paymentIntent = await stripe.paymentIntents.create({
          amount: amountMinor,
          currency: "usd",
          automatic_payment_methods: { enabled: true },
          metadata: { parcelId: parcelId || "", payerEmail: payerEmail || "" },
        });

        res.json({ clientSecret: paymentIntent.client_secret });
      } catch (error) {
        console.error("Stripe error:", error);
        res.status(400).json({ error: error.message });
      }
    });

    app.post("/payments/confirm", async (req, res) => {
      try {
        const { parcelId, paymentIntentId } = req.body;
        if (!parcelId || !paymentIntentId) {
          return res
            .status(400)
            .json({
              success: false,
              message: "parcelId and paymentIntentId are required",
            });
        }

        const pi = await stripe.paymentIntents.retrieve(paymentIntentId);
        if (!pi || pi.status !== "succeeded") {
          return res
            .status(400)
            .json({ success: false, message: "PaymentIntent not succeeded" });
        }

        const orFilter = [];
        if (ObjectId.isValid(parcelId))
          orFilter.push({ _id: new ObjectId(parcelId) });
        orFilter.push({ _id: parcelId });
        const parcelFilter =
          orFilter.length > 1 ? { $or: orFilter } : orFilter[0];

        await parcelsCollection.updateOne(parcelFilter, {
          $set: { paymentStatus: "Paid", updatedAt: new Date() },
        });

        res
          .status(200)
          .json({
            success: true,
            message: "Payment recorded and parcel marked Paid",
          });
      } catch (err) {
        console.error("payments/confirm error:", err);
        res.status(500).json({ success: false, message: err.message });
      }
    });

    app.post("/riders", async (req, res) => {
      try {
        const rider = req.body;
        const result = await ridersCollection.insertOne(rider);
        res
          .status(201)
          .json({
            success: true,
            message: "Rider added successfully",
            insertedId: result.insertedId,
          });
      } catch (error) {
        console.error("Error adding rider:", error);
        res
          .status(500)
          .json({ success: false, message: "Failed to add rider" });
      }
    });

    app.get("/riders/pending", async (_req, res) => {
      try {
        const pendingRiders = await ridersCollection
          .find({ status: { $in: ["Pending", "pending"] } })
          .toArray();
        return res.status(200).json(pendingRiders);
      } catch (error) {
        console.error("Error fetching pending riders:", error);
        res
          .status(500)
          .json({ message: "Error fetching pending riders", error });
      }
    });

    app.patch("/riders/:id", async (req, res) => {
      try {
        const id = req.params.id;
        let { status, email } = req.body;

        if (!ObjectId.isValid(id)) {
          return res
            .status(400)
            .json({ success: false, message: "Invalid Rider ID" });
        }
        if (!email || !status) {
          return res
            .status(400)
            .json({ success: false, message: "Missing email or status" });
        }

        status = status.toLowerCase();

        const riderQuery = { _id: new ObjectId(id) };
        const updateRider = { $set: { status } };
        const riderResult = await ridersCollection.updateOne(
          riderQuery,
          updateRider
        );

        if (riderResult.matchedCount === 0) {
          return res
            .status(404)
            .json({ success: false, message: "Rider not found" });
        }

        const userQuery = { email };
        let updateUserRole = {};

        if (status === "active") {
          updateUserRole = { $set: { role: "rider" } };
        } else if (status === "pending" || status === "rejected") {
          updateUserRole = { $set: { role: "user" } };
        }

        const userResult = await usersCollection.updateOne(
          userQuery,
          updateUserRole
        );
        if (userResult.matchedCount === 0) {
          console.warn("⚠️ No user found for email:", email);
        }

        res.status(200).json({
          success: true,
          message:
            status === "active"
              ? "Rider activated and role updated to rider."
              : status === "pending"
                ? "Rider deactivated and moved to pending list."
                : "Rider rejected and role reverted to user.",
        });
      } catch (error) {
        console.error("❌ Rider update error:", error);
        res.status(500).json({
          success: false,
          message: "Server error while updating rider and user role.",
          error: error.message,
        });
      }
    });

    app.get("/riders/active", async (_req, res) => {
      try {
        const activeRiders = await ridersCollection
          .find({ status: { $in: ["active", "Active", "Approved"] } })
          .toArray();
        res.status(200).json(activeRiders);
      } catch (error) {
        console.error("Error fetching active riders:", error);
        res.status(500).json({ message: "Error fetching active riders" });
      }
    });

    app.get("/riders/by-district", async (req, res) => {
      try {
        const { district } = req.query;
        if (!district) {
          return res
            .status(400)
            .json({ success: false, message: "District is required" });
        }

        const riders = await ridersCollection
          .find({
            district: { $regex: district.trim(), $options: "i" },
            status: { $in: ["active", "Active", "approved", "Approved"] },
          })
          .toArray();

        if (!riders.length) {
          return res.status(404).json({
            success: false,
            message: `No active riders found for district: ${district}`,
            data: [],
          });
        }

        res.status(200).json({
          success: true,
          count: riders.length,
          data: riders,
        });
      } catch (error) {
        console.error("❌ Error fetching riders by district:", error);
        res.status(500).json({
          success: false,
          message: "Server error while fetching riders",
          error: error.message,
        });
      }
    });

    app.get("/riders/tasks", async (req, res) => {
      try {
        const { email } = req.query;
        const query = {
          assignedRiderEmail: email,
          $or: [
            { status: { $regex: /^In-Transit$/i } },
            { status: { $regex: /^Pending$/i } },
          ],
        };
        const parcels = await parcelsCollection
          .find(query)
          .sort({ updatedAt: -1 })
          .toArray();
        res
          .status(200)
          .json({ success: true, count: parcels.length, data: parcels });
      } catch (error) {
        console.error("❌ Error fetching rider tasks:", error);
        res.status(500).json({
          success: false,
          message: "Server error while fetching rider delivery tasks",
          error: error.message,
        });
      }
    });

    app.patch("/parcels/:id/assign", async (req, res) => {
      try {
        const { id } = req.params;
        const { riderId, riderName, riderEmail } = req.body;

        if (!riderId || !riderName) {
          return res
            .status(400)
            .json({ success: false, message: "Rider ID and Name required" });
        }

        const parcelUpdate = await parcelsCollection.updateOne(
          { _id: new ObjectId(id) },
          {
            $set: {
              assignedRiderId: riderId,
              assignedRiderName: riderName,
              assignedRiderEmail: riderEmail,
              status: "In-Transit",
              assignedAt: new Date(),
              updatedAt: new Date(),
            },
          }
        );

        const riderUpdate = await ridersCollection.updateOne(
          { _id: new ObjectId(riderId) },
          {
            $set: {
              workStatus: "Delivery",
              lastAssignedParcel: id,
              lastAssignedAt: new Date(),
            },
          }
        );

        res.status(200).json({
          success: true,
          message: "Rider assigned and parcel marked In-Transit",
          parcelModified: parcelUpdate.modifiedCount,
          riderModified: riderUpdate.modifiedCount,
        });
      } catch (error) {
        console.error("Error assigning rider:", error);
        res.status(500).json({
          success: false,
          message: "Server error while assigning rider",
          error: error.message,
        });
      }
    });

    app.patch("/parcels/:id/status", async (req, res) => {
      try {
        const { id } = req.params;
        const { status } = req.body;

        if (!ObjectId.isValid(id)) {
          return res.status(400).send({ success: false, message: "Invalid parcel ID" });
        }

        const parcel = await parcelsCollection.findOne({ _id: new ObjectId(id) });
        if (!parcel) {
          return res.status(404).send({ success: false, message: "Parcel not found" });
        }

        await parcelsCollection.updateOne(
          { _id: new ObjectId(id) },
          { $set: { status, updatedAt: new Date() } }
        );

        if (status.toLowerCase() === "delivered") {
          const isSameDistrict =
            parcel.riderDistrict?.toLowerCase() === parcel.receiverDistrict?.toLowerCase();

          const percentage = isSameDistrict ? 0.3 : 0.8;
          const riderEarning = (parcel.deliveryCost || 0) * percentage;

          await parcelsCollection.updateOne(
            { _id: new ObjectId(id) },
            { $set: { riderEarning } }
          );
        }

        res.send({ success: true, message: "Parcel status updated successfully" });
      } catch (err) {
        console.error("Error updating parcel status:", err);
        res.status(500).send({ success: false, message: err.message });
      }
    });

    app.get("/riders/completed", async (req, res) => {
      try {
        const { email } = req.query;
        if (!email) {
          return res.status(400).send({ success: false, message: "Email is required" });
        }

        const parcels = await parcelsCollection
          .find({
            assignedRiderEmail: email,
            status: { $regex: /^delivered$/i },
          })
          .sort({ updatedAt: -1 })
          .toArray();

        res.send({ success: true, data: parcels });
      } catch (err) {
        console.error("Error fetching completed deliveries:", err);
        res.status(500).send({ success: false, message: err.message });
      }
    });

    app.get("/tracking/:trackingId", async (req, res) => {
      try {
        const { trackingId } = req.params;
        if (!trackingId) {
          return res.status(400).json({ success: false, message: "Tracking ID is required" });
        }

        const parcel = await parcelsCollection.findOne({ trackingId });
        if (!parcel) {
          return res.status(404).json({ success: false, message: "Parcel not found" });
        }

        const history = await trackingCollection
          .find({ parcel_id: parcel._id })
          .sort({ time: 1 })
          .toArray();

        res.status(200).json({
          success: true,
          parcel,
          history,
        });
      } catch (err) {
        console.error("Error fetching tracking info:", err);
        res.status(500).json({ success: false, message: err.message });
      }
    });

    app.get("/payments", async (req, res) => {
      const { email } = req.query;
      try {
        const payments = await paymentsCollection
          .find({ payerEmail: email })
          .sort({ createdAt: -1 })
          .toArray();
        res.status(200).json({ success: true, data: payments });
      } catch (error) {
        console.error("Error fetching payments:", error);
        res
          .status(500)
          .json({ success: false, message: "Failed to fetch payments" });
      }
    });

    app.get("/", (_req, res) => res.send("🚀 ParcelX API is running..."));


  
    process.on("SIGINT", async () => {
      console.log("\n🛑 Shutting down...");
      await client.close();
      process.exit(0);
    });
  } catch (error) {
    console.error("MongoDB Connection Error:", error);
    process.exit(1);
  }
}

run().catch(console.dir);

// ✅ Local dev only (Vercel will handle requests automatically)
if (process.env.NODE_ENV !== "production") {
  app.listen(port, () =>
    console.log(`🌍 Server running locally at http://localhost:${port}`)
  );
}

// ✅ Export for Vercel serverless function
export default app;