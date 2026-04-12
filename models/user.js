const mongoose = require('mongoose');

const interestSchema = new mongoose.Schema({
  name: { type: String, required: true, unique: true, lowercase: true },
  category: { type: String, required: true }
});


const userSchema = new mongoose.Schema({
  firstName: { type: String, required: true },
  lastName: { type: String, required: true },
  userName: { type: String, required: true, unique: true, index: true },
  email: { type: String, required: true, unique: true, index: true },
  password: { type: String, required: true },
  birthDate: Date,  // required
  country: String,  // we get the country of the user via his IP using an external api ( in the front-end )
  photo: String, 
  verifiedAge: Date,
  numOfReports: { type: Number, default: 0 },
  totalReports: { type: Number, default: 0 },
  banDate: { type: Date }, // start date 
  banPeriod : {type : Number , default : 0} , // number of days
  verifiedPhoto: String,
  online: { type: Boolean, default: false },
  role: { type: String, enum: ['user', 'moderator'], default: 'user' },
  sex: String, // either male or female or prefer not to say
  friends: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  requests: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  interests: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Interest' }],

  history : [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }], // users that talked to randomly

  isVerified: { type: Boolean, default: false },
  verificationToken: { type: String },

  passwordResetToken:  { type: String },
  passwordResetExpiry: { type: Date   },
}, { timestamps: true });

userSchema.methods.hasInterestRelatedTo = async function(searchCategory) {
  await this.populate('interests');
  return this.interests.some(interest => 
    interest.category.toLowerCase() === searchCategory.category.toLowerCase() || 
    interest.name.toLowerCase() === searchCategory.name.toLowerCase()
  );
};

const ConnectionSchema = new mongoose.Schema({
    // Store both to make the relationship queryable from either side
    users: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
    createdAt: { type: Date, default: Date.now }
});

// index the users array for fast lookups
ConnectionSchema.index({ users: 1 });

const Connection = mongoose.model('Connection', ConnectionSchema);

const Interest = mongoose.model('Interest', interestSchema);

const User = mongoose.model('User', userSchema);

module.exports = {User,Interest , Connection};