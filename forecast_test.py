import requests

def get_user_location_by_input():
    """Asks the user for their city or zip code and converts it to coordinates."""
    city_name = input("📍 Enter your city or zip code (e.g., Seattle, WA): ").strip()
    
    geocoding_url = "https://geocoding-api.open-meteo.com/v1/search"
    params = {"name": city_name, "count": 1, "language": "en"}
    
    try:
        response = requests.get(geocoding_url, params=params, timeout=5)
        data = response.json()
        
        if "results" in data and len(data["results"]) > 0:
            location = data["results"][0]
            lat = location["latitude"]
            lon = location["longitude"]
            name = location["name"]
            admin = location.get("admin1", "")
            country = location.get("country", "")
            print(f"✅ Found Location: {name}, {admin}, {country} ({lat}, {lon})")
            return lat, lon
        else:
            print(f"⚠️ Could not find '{city_name}'. Defaulting to Seattle, WA.")
    except Exception as e:
        print(f"⚠️ Geocoding error: {e}. Defaulting to Seattle, WA.")
        
    # Fallback to Seattle coordinates
    return 47.6062, -122.3321

def get_hourly_forecast(lat, lon):
    """Fetches hourly weather from NWS API, falling back to Open-Meteo if NWS fails."""
    # 1. Try National Weather Service API first
    headers = {"User-Agent": "(weather-calendar-app, rohans69@uw.edu)"}
    points_url = f"https://api.weather.gov/points/{lat},{lon}"
    
    try:
        response = requests.get(points_url, headers=headers, timeout=5)
        if response.status_code == 200:
            points_data = response.json()
            hourly_url = points_data["properties"]["forecastHourly"]
            hourly_response = requests.get(hourly_url, headers=headers, timeout=5)
            if hourly_response.status_code == 200:
                print("✅ Successfully fetched from NWS API!")
                return hourly_response.json()
        print(f"⚠️ NWS API unavailable (Status: {response.status_code}). Switching to backup weather source...")
    except Exception as e:
        print(f"⚠️ NWS connection error: {e}. Switching to backup source...")

    # 2. Fallback: Open-Meteo API (Free, high reliability, no key needed)
    fallback_url = f"https://api.open-meteo.com/v1/forecast?latitude={lat}&longitude={lon}&hourly=temperature_2m,precipitation_probability,wind_speed_10m&temperature_unit=fahrenheit&wind_speed_unit=mph"
    backup_response = requests.get(fallback_url, timeout=5)
    
    if backup_response.status_code == 200:
        print("✅ Successfully fetched from Backup Weather API (Open-Meteo)!")
        data = backup_response.json()
        hourly = data["hourly"]
        return {
            "source": "Open-Meteo Backup",
            "temperature": hourly["temperature_2m"][0],
            "precip_prob": hourly["precipitation_probability"][0],
            "wind_speed": hourly["wind_speed_10m"][0]
        }
    
    print("❌ All weather services failed.")
    return None

if __name__ == "__main__":
    print("Initializing Weather-Calendar Project Test...")
    
    # Step 1: Get location coordinates from user input
    latitude, longitude = get_user_location_by_input()
    
    # Step 2: Fetch weather forecast with built-in redundancy
    print("\nFetching hourly forecast for your location...")
    forecast_data = get_hourly_forecast(latitude, longitude)
    
    # Step 3: Parse and display the output
    if forecast_data:
        if isinstance(forecast_data, dict) and forecast_data.get("source") == "Open-Meteo Backup":
            print(f"\n✅ Forecast Result ({forecast_data['source']}):")
            print(f"• Temperature: {forecast_data['temperature']}°F")
            print(f"• Precipitation Probability: {forecast_data['precip_prob']}%")
            print(f"• Wind Speed: {forecast_data['wind_speed']} mph")
        else:
            first_period = forecast_data["properties"]["periods"][0]
            print(f"\n✅ Success! Next Hour Forecast for {first_period['name']}:")
            print(f"• Temperature: {first_period['temperature']}°{first_period['temperatureUnit']}")
            print(f"• Forecast: {first_period['shortForecast']}")
            print(f"• Wind: {first_period['windSpeed']} {first_period['windDirection']}")
