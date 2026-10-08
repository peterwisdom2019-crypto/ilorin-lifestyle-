const express = require("express");
const path = require("path");
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const districts = [
  {id:"square", name:"City Square", icon:"🏙️", desc:"Meet people, explore and hang out."},
  {id:"food", name:"Food Street", icon:"🍲", desc:"Discover food spots and social rooms."},
  {id:"arts", name:"Arts Quarter", icon:"🎨", desc:"Art, music, creativity and culture."},
  {id:"night", name:"Nightlife District", icon:"🌃", desc:"Events, games and evening hangouts."},
  {id:"market", name:"Ilorin Market", icon:"🛍️", desc:"Virtual shops and local businesses."},
  {id:"wellness", name:"Wellness Park", icon:"🌳", desc:"Relax, connect and enjoy the park."}
];

app.get("/api/health", (_, res) => res.json({ok:true, service:"Ilorin Lifestyle"}));
app.get("/api/city", (_, res) => res.json({name:"Ilorin Lifestyle", districts}));
app.get("*", (_, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

app.listen(PORT, () => console.log(`Ilorin Lifestyle running on port ${PORT}`));
