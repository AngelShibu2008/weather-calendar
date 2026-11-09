import requests

def get_user_location_by_ip():
    """Automatically fetches latitude and longitude based on the user's IP address."""
    try:
        # Calls a free IP geolocation API
        response = requests.get("https://ipapi.co/json/", timeout=5)
        data = response.json()
        
        # Check if the API returned valid coordinates
        if "latitude" in data and "longitude" in data:
            lat = data["latitude"]
            lon = data["longitude"]
            print(f"📍 Detected Location: {data.get('city')}, {data.get('region')} ({lat}, {lon})")
            return lat, lon
    except Exception as e:
        print(f"Could not detect location by IP ({e}), defaulting to Seattle.")
    
    # Fallback to University of Washington campus coordinates if IP lookup fails
    return 47.6062, -122.3321

def get_hourly_forecast(lat, lon):
    headers = {
        "User-Agent": "(weather-calendar-app, rohans69@uw.edu)"
    }

    # 1. Call the /points endpoint to get grid metadata for the coordinates
    points_url = f"https://api.weather.gov/points/{lat},{lon}"
    response = requests.get(points_url, headers=headers)
    
    if response.status_code != 200:
        print(f"Error fetching points data: {response.status_code}")
        return None

    points_data = response.json()
    
    # 2. Extract the hourly forecast URL from the properties
    hourly_url = points_data["properties"]["forecastHourly"]

    # 3. Fetch the hourly forecast data
    hourly_response = requests.get(hourly_url, headers=headers)
    
    if hourly_response.status_code != 200:
        print(f"Error fetching hourly forecast: {hourly_response.status_code}")
        return None

    return hourly_response.json()

if __name__ == "__main__":
    print("Detecting current location...")
    # Automatically get the current location coordinates
    latitude, longitude = get_user_location_by_ip()
    
    print("Fetching NWS hourly forecast for your location...")
    forecast_data = get_hourly_forecast(latitude, longitude)
    
    if forecast_data:
        # Print the first hourly period as a test
        first_period = forecast_data["properties"]["periods"][0]
        print(f"\nSuccess! Next Hour Forecast for {first_period['name']}:")
        print(f"Temperature: {first_period['temperature']}°{first_period['temperatureUnit']}")
        print(f"Forecast: {first_period['shortForecast']}")
        print(f"Wind: {first_period['windSpeed']} {first_period['windDirection']}")
