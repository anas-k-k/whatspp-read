// config/templates.js
module.exports = {
  GREETING_TEMPLATE: (customerName = "there", productList = "") => `
Hi ${customerName},
Thank you for reaching out to Chembys 💛
Here's our product list for you:
${productList}
would you like to know more about any specific product? or order any?
`,
  USAGE_KASTHURI: `
For dry skin, mix with milk or curd.
For oily skin, use rose water or aloe vera.
For sensitive skin, use with red sandalwood powder + rose water.
Apply after sunset, leave for 15-20 mins, and rinse with plain water (no soap).
Use 5 times in first week, after that weekly 2-3 times.
Always do a patch test first.
`,

  USAGE_CARROT: `
Apply 4-5 drops to clean skin and massage in circular motion.
Leave overnight and wash in the morning.
For hair, apply to scalp and ends, leave 30 mins, and shampoo.
Brightens skin, fades tan, and is non-sticky.
`,

  CANCEL_TEMPLATE: `
Hi! 😊 Our products are not like regular cosmetics.
We grow the ingredients on our own farm in Wayanad, Kerala and make everything by hand in small batches.
It's 100% chemical-free and follows a 200-year-old traditional formula.
Please think again before cancelling - we put so much care into every bottle just for you. ❤️
`,

  PINCODE_MISMATCH: (city) => `
It looks like the pincode doesn’t match the city/area: ${city}.
Could you please double-check the pincode so we can ensure proper delivery? 😊
`,

  ORDER_CONFIRM: ({
    name,
    phone,
    address,
    items,
    totalAmount,
    paymentMode,
  }) => {
    const codCharge = paymentMode.toLowerCase() === "cod" ? 30 : 0;
    const finalAmount = totalAmount + codCharge;

    return `
Thanks for sharing your details!
📍 Name: ${name}
📞 Phone: ${phone}
🏠 Address: ${address}

🛍️ Order Summary:
${items
  .map((item) => `• ${item.productName} × ${item.quantity} = ₹${item.amount}`)
  .join("\n")}

${paymentMode.toLowerCase() === "cod" ? "🔒 COD Charge: ₹30" : ""}
💰 Total Amount: ₹${finalAmount} (${paymentMode.toUpperCase()})

${
  paymentMode.toLowerCase() === "cod"
    ? "No need to pay now. Please keep ₹" +
      finalAmount +
      " ready at delivery 📦"
    : "Please pay ₹" +
      finalAmount +
      " via Google Pay to: +91 9656190290\nOnce done, kindly send a screenshot so we can confirm your order."
}
`;
  },

  PRODUCT_LIST: `
*SKIN CARE PRODUCTS*
- Kumkumadi Brightening Cream - ₹689
- Rose Dew Face Cleanser - ₹299
- Red Sandalwood Powder (50g) - ₹449
- Wayanadan Turmeric Oil - ₹399
- Carrot Seed Oil - ₹420
- Melasma Face pack (80g) - ₹599
- ABC Face & Body Oil - ₹299
- Kasthuri Manjal Magic Powder - ₹497

*🎁 SKIN CARE COMBOS*
- White Turmeric + Carrot Oil Combo - ₹847
- Melasma Shield + Kasturi Manjal Combo - ₹995

*🧖 HAIR CARE*
- No-Flak Anti-Dandruff Hair Oil - ₹328
- Extra Virgin Coconut Oil (100ml) - ₹297

*🌿 ESSENTIAL OIL*
- Natural De-Stress Relax Oil (Pack of 3) - ₹360 (Combo MRP ₹749)
`,

  COMBO_SUGGESTIONS: `
Here are some suggestions that work great for different concerns:
• For pigmentation: Melasma Shield + Kasthuri Manjal
• For pimples: Red Sandalwood Powder or White Turmeric + Carrot Oil
• For dry skin: Carrot Oil or Rose Body Butter
• For dandruff/hair fall: No-Flak Oil or Coconut Oil
• For babies: ABC Face & Body Oil
`,

  PAYMENT_INSTRUCTIONS: `
Great! How would you like to pay?
We support:
• Google Pay – no extra cost
• Cash on Delivery – ₹30 extra applies

Can I collect your full billing details?
`,
};
