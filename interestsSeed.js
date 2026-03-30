const { Interest } = require('./models/user'); // Adjust path as needed

const extraInterests = [
  // --- OUTDOORS & ADVENTURE ---
  { name: 'rock climbing', category: 'Outdoors' },
  { name: 'camping', category: 'Outdoors' },
  { name: 'bird watching', category: 'Outdoors' },
  { name: 'fishing', category: 'Outdoors' },
  { name: 'archery', category: 'Outdoors' },
  { name: 'kayaking', category: 'Outdoors' },
  { name: 'scuba diving', category: 'Outdoors' },
  { name: 'stargazing', category: 'Science' },
  { name: 'parkour', category: 'Fitness' },
  { name: 'mountain biking', category: 'Sports' },

  // --- COLLECTIBLES & NOSTALGIA ---
  { name: 'vinyl records', category: 'Hobbies' },
  { name: 'comic books', category: 'Hobbies' },
  { name: 'sneaker collecting', category: 'Fashion' },
  { name: 'vintage clothing', category: 'Fashion' },
  { name: 'lego building', category: 'Hobbies' },
  { name: 'action figures', category: 'Hobbies' },
  { name: 'stamp collecting', category: 'Hobbies' },
  { name: 'antique restoration', category: 'Hobbies' },

  // --- TECHNOLOGY & FUTURE ---
  { name: 'virtual reality', category: 'Technology' },
  { name: 'robotics', category: 'Technology' },
  { name: 'drones', category: 'Technology' },
  { name: '3d printing', category: 'Technology' },
  { name: 'game development', category: 'Technology' },
  { name: 'data science', category: 'Technology' },
  { name: 'iot', category: 'Technology' },
  { name: 'ethical hacking', category: 'Technology' },
  { name: 'ux design', category: 'Design' },
  { name: 'interior design', category: 'Design' },

  // --- FOOD & DRINK ---
  { name: 'coffee brewing', category: 'Lifestyle' },
  { name: 'wine tasting', category: 'Lifestyle' },
  { name: 'veganism', category: 'Lifestyle' },
  { name: 'mixology', category: 'Lifestyle' },
  { name: 'bbq', category: 'Lifestyle' },
  { name: 'tea ceremony', category: 'Lifestyle' },
  { name: 'pastry art', category: 'Lifestyle' },
  { name: 'sushi making', category: 'Lifestyle' },

  // --- PERFORMANCE & ENTERTAINMENT ---
  { name: 'theatre', category: 'Arts' },
  { name: 'ballet', category: 'Arts' },
  { name: 'magic tricks', category: 'Entertainment' },
  { name: 'opera', category: 'Music' },
  { name: 'jazz', category: 'Music' },
  { name: 'hip hop', category: 'Music' },
  { name: 'k-pop', category: 'Music' },
  { name: 'true crime', category: 'Entertainment' },
  { name: 'documentaries', category: 'Entertainment' },
  { name: 'blogging', category: 'Media' },

  // --- HEALTH & WELLNESS ---
  { name: 'pilates', category: 'Fitness' },
  { name: 'crossfit', category: 'Fitness' },
  { name: 'marathon running', category: 'Fitness' },
  { name: 'mental health', category: 'Wellness' },
  { name: 'aromatherapy', category: 'Wellness' },
  { name: 'journaling', category: 'Wellness' },
  { name: 'tai chi', category: 'Fitness' },
  { name: 'skincare', category: 'Lifestyle' },

  // --- ACADEMIC & SOCIAL SCIENCE ---
  { name: 'philosophy', category: 'Education' },
  { name: 'sociology', category: 'Education' },
  { name: 'economics', category: 'Education' },
  { name: 'linguistics', category: 'Education' },
  { name: 'archaeology', category: 'Science' },
  { name: 'biology', category: 'Science' },
  { name: 'physics', category: 'Science' },
  { name: 'politics', category: 'Social' },
  { name: 'human rights', category: 'Social' },
  { name: 'sustainability', category: 'Social' },

  // --- GAMING & STRATEGY ---
  { name: 'poker', category: 'Gaming' },
  { name: 'bridge', category: 'Gaming' },
  { name: 'tabletop rpgs', category: 'Gaming' },
  { name: 'retro gaming', category: 'Gaming' },
  { name: 'speedrunning', category: 'Gaming' },
  { name: 'warhammer', category: 'Gaming' },
  { name: 'cardistry', category: 'Hobbies' },

  // --- CRAFTS & DIY ---
  { name: 'woodworking', category: 'Crafts' },
  { name: 'knitting', category: 'Crafts' },
  { name: 'pottery', category: 'Crafts' },
  { name: 'sewing', category: 'Crafts' },
  { name: 'jewelry making', category: 'Crafts' },
  { name: 'calligraphy', category: 'Arts' },
  { name: 'origami', category: 'Arts' },
  { name: 'blacksmithing', category: 'Crafts' },

  // --- SPORTS (MISC) ---
  { name: 'tennis', category: 'Sports' },
  { name: 'golf', category: 'Sports' },
  { name: 'badminton', category: 'Sports' },
  { name: 'volleyball', category: 'Sports' },
  { name: 'fencing', category: 'Sports' },
  { name: 'rugby', category: 'Sports' },
  { name: 'cricket', category: 'Sports' },
  { name: 'formula 1', category: 'Sports' },
  { name: 'motocross', category: 'Sports' },
  { name: 'wrestling', category: 'Sports' },

  // --- NICHES & OTHERS ---
  { name: 'urban exploration', category: 'Outdoors' },
  { name: 'genealogy', category: 'Education' },
  { name: 'cryptography', category: 'Technology' },
  { name: 'survivalism', category: 'Lifestyle' },
  { name: 'taxidermy', category: 'Hobbies' },
  { name: 'puppetry', category: 'Arts' },
  { name: 'vlogging', category: 'Media' },
  { name: 'minimalism', category: 'Lifestyle' },
  { name: 'public speaking', category: 'Education' },
  { name: 'meditation', category: 'Wellness' }
];

// Usage: Interest.insertMany(extraInterests, { ordered: false });

async function seedInterests() {
  try {
    // ordered: false allows continuing even if there's a duplicate key error
    const result = await Interest.insertMany(extraInterests, { ordered: false });
    console.log(`${result.length} interests seeded successfully!`);
  } catch (error) {
    if (error.code === 11000) {
      console.log('Some interests already existed and were skipped.');
    } else {
      console.error('Error seeding interests:', error);
    }
  }
}

module.exports = {seedInterests};
// Call this function once during your app initialization or via a separate script
// seedInterests();