#!/usr/bin/env bash
# Test suite for on-demand-goose-execution service
# Each request targets a different high-anti-bot website
# Run: bash scripts/test-execute-endpoints.sh [BASE_URL]

BASE_URL="${1:-http://localhost:3000}"
ENDPOINT="$BASE_URL/admin/v1/execute"
PROVIDER="${PROVIDER:-gcp_vertex_ai}"
MODEL="${MODEL:-gemini-3.5-flash}"
EFFORT="${EFFORT:-high}"

run_test() {
  local test_name="$1"
  local session_id="$2"
  local message_id="$3"
  local prompt="$4"

  echo ""
  echo "========================================"
  echo "TEST: $test_name"
  echo "========================================"

  curl -s -X POST "$ENDPOINT" \
    --header 'Content-Type: application/json' \
    --data "$(jq -n \
      --arg prompt "$prompt" \
      --arg provider "$PROVIDER" \
      --arg model "$MODEL" \
      --arg session_id "$session_id" \
      --arg message_id "$message_id" \
      --arg effort "$EFFORT" \
      '{
        prompt: $prompt,
        provider: $provider,
        model: $model,
        company_id: "smoke-test-company",
        session_id: $session_id,
        message_id: $message_id,
        speed: "",
        effort: $effort,
        file_urls: []
      }')" | jq '.'

  echo ""
}

# ─── 1. IRCTC – Train booking (heavy CAPTCHA + session auth) ───────────────────
run_test "IRCTC Train Booking" "sess-test-irctc-01" "msg-irctc-01" \
'Go to irctc.co.in and search for a train ticket.
Search criteria:
  From: Mumbai CST (CSTM)
  To: New Delhi (NDLS)
  Date: tomorrow
  Class: 3A (AC 3 Tier)
  Quota: General

Steps:
1. Navigate to irctc.co.in
2. Take a snapshot of the homepage
3. Fill in the source, destination, date fields
4. Click "Find Trains"
5. List the top 5 available trains with: Train name, number, departure time, arrival time, duration, availability, fare
6. Select the train with the best availability and reasonable fare
7. Proceed to passenger details page

Guest/contact details:
  Name: John Doe
  Age: 30
  Gender: Male
  Mobile: +91 8269091282
  Email: john.doe@example.com

Instructions:
- Use only Chrome DevTools MCP tools
- Take a snapshot before every click
- After every major step output a plain-text status line
- Do NOT submit payment or complete any OTP
- Stop at the payment/UPI screen
- Output the final payment URL as plain text immediately when reached
- If you hit a CAPTCHA, describe it and stop
- Do not make more than 3 consecutive tool calls without outputting text'

# ─── 2. Zomato – Restaurant table booking ──────────────────────────────────────
run_test "Zomato Restaurant Table Booking" "sess-test-zomato-01" "msg-zomato-01" \
'Go to zomato.com and book a table at a restaurant.
Search criteria:
  City: Mumbai
  Cuisine: North Indian
  Date: tomorrow
  Time: 8:00 PM
  Party size: 2
  Sort by: Highest rated

Steps:
1. Navigate to zomato.com
2. Switch to "Dining" or "Book a Table" mode (not food delivery)
3. Take a snapshot of the page
4. Search for restaurants matching the criteria
5. Show a table of top 5 results with: Name, Rating, Cuisine, Price for two, Distance
6. Pick the highest-rated option and open its booking page
7. Select date, time, party size
8. Fill contact details:
   Name: Jane Smith
   Mobile: +91 8269091282
   Email: jane.smith@example.com
9. Proceed as far as possible without submitting

Instructions:
- Use only Chrome DevTools MCP tools
- Take a snapshot before every click
- Output a status line after: page loaded, search results shown, restaurant selected, booking form filled
- Do NOT confirm or pay
- Stop at any OTP or payment screen
- Output the booking confirmation URL as plain text when reached
- Do not make more than 3 consecutive tool calls without outputting text'

# ─── 3. Naukri – Job application ───────────────────────────────────────────────
run_test "Naukri Job Application" "sess-test-naukri-01" "msg-naukri-01" \
'Go to naukri.com and apply for a software engineering job.
Search criteria:
  Job title: Software Engineer
  Location: Bangalore
  Experience: 2-5 years
  Skills: Python, React
  Posted: last 7 days

Steps:
1. Navigate to naukri.com
2. Take a snapshot of the homepage
3. Search with the above criteria
4. List the top 5 job results with: Company, Title, Experience required, Salary range, Posted date
5. Click on the most relevant job listing
6. Take a snapshot of the job detail page
7. Click "Apply" and navigate to the application form
8. Fill contact details:
   Name: John Doe
   Email: john.doe@example.com
   Phone: +91 8269091282
9. Do NOT submit the application

Instructions:
- Use only Chrome DevTools MCP tools
- Take a snapshot before every click
- Output a status line after: search results shown, job selected, application form reached
- Stop before final submit
- Output the job application URL as plain text when reached
- If a login wall appears, describe it and stop
- Do not make more than 3 consecutive tool calls without outputting text'

# ─── 4. Swiggy – Food order flow (JavaScript-heavy SPA) ────────────────────────
run_test "Swiggy Food Order" "sess-test-swiggy-01" "msg-swiggy-01" \
'Go to swiggy.com and place a food order.
Search criteria:
  Delivery address: Bandra West, Mumbai 400050
  Restaurant type: Pizza
  Filter: Rating 4.0+, Delivery under 40 mins
  Order value: Under ₹500

Steps:
1. Navigate to swiggy.com
2. Set the delivery location to "Bandra West, Mumbai 400050"
3. Take a snapshot after location is set
4. Search for Pizza restaurants
5. List the top 5 restaurants with: Name, Rating, Delivery time, Min order, Distance
6. Pick the highest-rated restaurant under the constraints
7. Select 2 menu items totaling under ₹500
8. Add to cart and proceed to checkout
9. Fill contact details:
   Name: John Doe
   Mobile: +91 8269091282
   Address: 123 Test Street, Bandra West, Mumbai 400050

Instructions:
- Use only Chrome DevTools MCP tools
- Take a snapshot before every click
- Output a status line after: location set, restaurants listed, items added to cart, checkout reached
- Do NOT complete payment or submit OTP
- Stop at the payment screen
- Output the checkout URL as plain text immediately when reached
- Do not make more than 3 consecutive tool calls without outputting text'

# ─── 5. Ticketmaster – Concert/event ticket booking (US, heavy bot protection) ─
run_test "Ticketmaster Event Booking" "sess-test-ticketmaster-01" "msg-ticketmaster-01" \
'Go to ticketmaster.com and find event tickets.
Search criteria:
  Location: New York, NY
  Event type: Concert
  Date range: next 2 weeks
  Price: Under $100

Steps:
1. Navigate to ticketmaster.com
2. Take a snapshot of the homepage
3. Search for concerts in New York in the next 2 weeks
4. List the top 5 events with: Event name, Artist, Venue, Date/Time, Price range, Tickets available
5. Select the most popular event (highest interest)
6. Take a snapshot of the event detail page
7. Click "Find Tickets"
8. Select 2 tickets in the best available price range under $100
9. Proceed to checkout

Contact details:
  Name: John Doe
  Email: john.doe@example.com
  Phone: +1 8269091282

Instructions:
- Use only Chrome DevTools MCP tools
- Take a snapshot before every click
- Output a status line after: events listed, event selected, tickets chosen, checkout reached
- Do NOT complete payment or submit any OTP/verification
- Stop at the payment/card details screen
- Output the checkout URL as plain text immediately when reached
- If you encounter a queue or waiting room, describe it and wait up to 30 seconds
- Do not make more than 3 consecutive tool calls without outputting text'

# ─── 6. Myntra – Fashion e-commerce (heavy analytics + bot detect) ─────────────
run_test "Myntra Fashion Purchase" "sess-test-myntra-01" "msg-myntra-01" \
'Go to myntra.com and purchase a clothing item.
Search criteria:
  Category: Men casual t-shirts
  Size: M
  Color: Any
  Price: Under ₹600
  Brand: Any with rating 4.0+
  Sort by: Popularity

Steps:
1. Navigate to myntra.com
2. Take a snapshot of the homepage
3. Navigate to Men > T-Shirts > Casual
4. Apply filters: Size M, Price 0-600, Rating 4+
5. List the top 5 results with: Brand, Name, Price, Rating, Discount %
6. Select the best value item (highest rating with best discount)
7. Select size M and click "Add to Bag"
8. Proceed to cart, then checkout
9. Fill address details:
   Name: John Doe
   Address: 123 Test Street, Bandra West
   City: Mumbai
   Pincode: 400050
   Mobile: +91 8269091282

Instructions:
- Use only Chrome DevTools MCP tools
- Take a snapshot before every click
- Output a status line after: category page loaded, filters applied, item selected, cart reached, checkout reached
- Do NOT complete payment or submit OTP
- Stop at the payment options screen
- Output the checkout URL as plain text immediately when reached
- If a login wall appears, describe it and stop
- Do not make more than 3 consecutive tool calls without outputting text'

# ─── 7. StubHub – Secondary ticket market (strong Akamai bot protection) ────────
run_test "StubHub Ticket Purchase" "sess-test-stubhub-01" "msg-stubhub-01" \
'Go to stubhub.com and find sports event tickets.
Search criteria:
  Sport: NBA Basketball
  Location: Los Angeles, CA
  Date range: next 3 weeks
  Quantity: 2 tickets
  Price: Under $150 each

Steps:
1. Navigate to stubhub.com
2. Take a snapshot of the homepage
3. Search for NBA games in Los Angeles in the next 3 weeks
4. List the top 5 events with: Teams, Venue, Date/Time, Cheapest ticket price, Availability
5. Select the game with the best value (popular matchup, reasonable price)
6. Take a snapshot of the event page
7. Select 2 tickets under $150 each in the best available section
8. Proceed to checkout

Contact details:
  Name: John Doe
  Email: john.doe@example.com

Instructions:
- Use only Chrome DevTools MCP tools
- Take a snapshot before every click
- Output a status line after: events listed, event selected, seats chosen, checkout reached
- Do NOT complete payment or submit any verification
- Stop at the payment/card details screen
- Output the checkout URL as plain text immediately when reached
- If you encounter bot detection or a CAPTCHA, describe it and stop
- Do not make more than 3 consecutive tool calls without outputting text'

# ─── 8. Airbnb – Accommodation booking (dynamic pricing + JS-heavy) ─────────────
run_test "Airbnb Accommodation Booking" "sess-test-airbnb-01" "msg-airbnb-01" \
'Go to airbnb.com and find accommodation to book.
Search criteria:
  Destination: Goa, India
  Check-in: day after tomorrow
  Check-out: 3 nights later
  Guests: 2 adults
  Price: Under $80/night
  Type: Entire place
  Sort by: Guest favourite

Steps:
1. Navigate to airbnb.com
2. Take a snapshot of the homepage
3. Enter search criteria (destination, dates, guests)
4. Apply filters: Entire place, Under $80/night
5. List the top 5 listings with: Name, Price/night, Rating, Reviews count, Distance from center
6. Select the highest-rated listing under $80/night
7. Take a snapshot of the listing detail page
8. Click "Reserve"
9. Fill guest details:
   Name: John Doe
   Email: john.doe@example.com
   Phone: +91 8269091282

Instructions:
- Use only Chrome DevTools MCP tools
- Take a snapshot before every click
- Output a status line after: search results shown, listing selected, booking form reached, payment page reached
- Do NOT complete payment or submit any OTP
- Stop at the payment/card details screen
- Output the checkout URL as plain text immediately when reached
- Do not make more than 3 consecutive tool calls without outputting text'

echo ""
echo "========================================"
echo "All tests dispatched."
echo "========================================"
