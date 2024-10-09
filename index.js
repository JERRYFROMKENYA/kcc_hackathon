require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { Web5 } = require("@web5/api");
const { LocalStorage } = require('node-localstorage');

// Core initialization
const app = express();
const PORT = process.env.PORT || 3000;
app.use(express.json());
app.use(cors({ origin: "*" }));

// Initialize localStorage if not already defined
if (typeof localStorage === "undefined" || localStorage === null) {
    localStorage = new LocalStorage('./scratch');
}

// Function to remove circular references from objects
function removeCircularReferences() {
    const seen = new WeakSet();
    return function (key, value) {
        if (typeof value === "object" && value !== null) {
            if (seen.has(value)) {
                return undefined; // Remove circular reference
            }
            seen.add(value);
        }
        return value;
    };
}

// Function to generate a dynamic expiration date
function getExpirationDate(days = 30) {
    const date = new Date();
    date.setDate(date.getDate() + days);
    return date.toISOString();
}

// Function to initialize Web5 and register DID
async function initialize() {
    try {
        const { did, web5 } = await Web5.connect({
            didCreateOptions: { dwnEndpoints: ['https://dwn.gcda.xyz'] },
            registration: {
                onSuccess: () => {
                    localStorage.setItem("registered", "true");
                    console.log("Registration succeeded");
                },
                onFailure: (error) => {
                    console.error("Registration failed:", error);
                },
            },
        });

        const protocolDefinition = {
            "protocol": "https://vc-to-dwn.tbddev.org/vc-protocol",
            "published": true,
            "types": {
                "credential": {
                    "schema": "https://vc-to-dwn.tbddev.org/vc-protocol/schema/credential",
                    "dataFormats": ["application/vc+jwt"]
                },
                "issuer": {
                    "schema": "https://vc-to-dwn.tbddev.org/vc-protocol/schema/issuer",
                    "dataFormats": ["text/plain"]
                },
                "judge": {
                    "schema": "https://vc-to-dwn.tbddev.org/vc-protocol/schema/judge",
                    "dataFormats": ["text/plain"]
                }
            },
            "structure": {
                "issuer": { "$role": true },
                "judge": { "$role": true },
                "credential": {
                    "$actions": [
                        { "role": "issuer", "can": ["create"] },
                        { "role": "judge", "can": ["query", "read"] }
                    ]
                }
            }
        };

        const { protocol } = await web5.dwn.protocols.configure({
            message: { definition: protocolDefinition }
        });

        await protocol.send(did);

        localStorage.setItem("didURI", did);
        localStorage.setItem("authURL", `https://vc-to-dwn.tbddev.org/authorize?issuerDid=${did}`);
        const { did: dwnBearerDid } = await web5.agent.identity.get({ didUri: localStorage.getItem("didURI") });
        localStorage.setItem("dwnBearerDid.json", JSON.stringify(dwnBearerDid, removeCircularReferences()));
        console.log(dwnBearerDid);
    } catch (error) {
        console.error("Initialization failed:", error);
    }
}

// Function to issue and sign a credential
async function issueAndSignCredential(custDid) {
    try {
        console.log("IssueAndSignCredential");

        const { VerifiableCredential } = await import('@web5/credentials');
        const vc = await VerifiableCredential.create({
                issuer: localStorage.getItem("didURI"),
                subject: custDid,
                expirationDate: getExpirationDate(365),
                data: {
                    countryOfResidence: "KE", // 2 letter country code
                    tier: "Bonafide Customer Tier",
                    jurisdiction: {
                        country: "KE"
                    },
                },
                credentialsSchema: {
                    id: "https://vc.schemas.host/kcc.schema.json",
                    type: "JsonSchema",
                },
                evidence:[
                    {
                        "kind": "document_verification",
                        "checks": ["passport", "utility_bill"]
                    },
                    {
                        "kind": "sanction_screening",
                        "checks": ["PEP"]
                    }
                ]

            }


        );

        const { web5 } = await Web5.connect();
        const { did: dwnBearerDid } = await web5.agent.identity.get({ didUri: localStorage.getItem("didURI") });

        const signed_vc = await vc.sign({ did: dwnBearerDid });

        const { record } = await web5.dwn.records.create({
            data: signed_vc,
            store:false,
            message: {
                protocol: "https://vc-to-dwn.tbddev.org/vc-protocol",
                protocolPath: "credential",
                schema: "https://vc-to-dwn.tbddev.org/vc-protocol/schema/credential",
                recipient: custDid,
                dataFormat: "application/vc+jwt",
                protocolRole: "issuer",
            },
        });

        const { status} = await record.send(custDid);
        console.log("Record", record);
        console.log("Status", status);


        const {records} = await web5.dwn.records.query({
            from: custDid,
            message: {
                filter: {
                    dataFormat: 'application/vc+jwt',
                    author: localStorage.getItem("didURI"),
                },
            },
        });

        return { status, record, id: records[records.length-1], KCC:signed_vc };
    } catch (error) {
        console.error("Issue and sign credential failed:", error);
    }
}

// Function to get record
async function getRecord(custDid) {
    try {
        const { web5 } = await Web5.connect();
        const {records} = await web5.dwn.records.query({
            from: custDid,
            message: {
                filter: {
                    dataFormat: 'application/vc+jwt',
                    author: localStorage.getItem("didURI"),
                },
            },
        });


        // console.log("RECORD", status);

        // console.log(Object.entries(records[records.length - 1]));



        return {record: records[records.length - 1],
        content: record
        };
    } catch (e) {
        return e;
    }
}

// Function to get permission
async function getPermission() {
    try {
        const response = await fetch(`https://vc-to-dwn.tbddev.org/authorize?issuerDid=${localStorage.getItem("didURI")}`);
        const data = await response.json();
        console.log("GET PERMISSION", data);
        return data;
    } catch (error) {
        console.error("Get permission failed:", error);
    }
}

// Routes
app.post("/", async (req, res) => {
    const { custDid } = req.body;
    const records = await getRecord(custDid);
    res.send(records);
});

app.post("/get-credential", async (req, res) => {
    const { custDid } = req.body;

    if (localStorage.getItem("permission") !== "true") {
        await getPermission().then(() => {
            localStorage.setItem("permission", "true");
        });
    }

    const data = await issueAndSignCredential(custDid);
    res.json({ status: data.status ?? "", record: data.record ?? "", id: data.id ?? "", KCC: data.KCC ?? ""});
});

app.post("/get-permission", async (req, res) => {
    const data = await getPermission();
    res.json(data);
    localStorage.setItem("permission", "true");
});

// Start server and initialize if not already registered
app.listen(PORT, () => {
    if (localStorage.getItem("registered") !== "true") {
        initialize().then(() => { });
    } else {
        console.log("Already registered");
        console.log(localStorage.getItem("didURI"), "DID URI", localStorage.getItem("authURL"), "Auth URL");
    }
    console.log(`Server is running on port ${PORT}`);
});